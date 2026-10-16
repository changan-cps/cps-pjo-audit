from PIL import Image, ImageDraw, ImageFilter
import numpy as np
src=Image.open('/root/.claude/uploads/e1bb3b71-ade9-549f-928f-13f52476e988/54d3a523-image.webp').convert('RGB')
# remove white background: flood fill from the borders
work=src.copy(); W,H=work.size
for x,y in [(0,0),(W-1,0),(0,H-1),(W-1,H-1),(W//2,5),(5,H//2),(W-6,H//2)]:
    ImageDraw.floodfill(work,(x,y),(255,0,255),thresh=40)
a=np.array(work); mask=~((a[:,:,0]==255)&(a[:,:,1]==0)&(a[:,:,2]==255))
alpha=Image.fromarray((mask*255).astype('uint8')).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
cut=src.convert('RGBA'); cut.putalpha(alpha)
half=cut.crop((185,318,800,1010))   # cap to just below belt, incl. clipboard
pad=24; big=Image.new('RGBA',(half.width+2*pad,half.height+pad),(0,0,0,0)); big.paste(half,(pad,pad),half)
al=big.split()[3].point(lambda v:255 if v>100 else 0).filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.GaussianBlur(1.2))
stroke=Image.new('RGBA',big.size,(255,255,255,255)); stroke.putalpha(al)
half=Image.alpha_composite(stroke,big)
half.save('/tmp/claude-0/mascot/half.png')
def bg(size, radius):
    g=Image.new('RGBA',(size,size)); px=g.load()
    for y in range(size):
        for x in range(size):
            t=(x+y)/(2*size); c0=(0x1e,0x6f,0xd0); c1=(0x0a,0x2e,0x6e)
            px[x,y]=tuple(int(c0[i]+(c1[i]-c0[i])*t) for i in range(3))+(255,)
    # soft light circle behind head
    glow=Image.new('RGBA',(size,size),(0,0,0,0)); d=ImageDraw.Draw(glow)
    r=int(size*0.36); cx,cy=size//2,int(size*0.42); d.ellipse((cx-r,cy-r,cx+r,cy+r),fill=(255,255,255,40))
    g=Image.alpha_composite(g,glow)
    if radius:
        m=Image.new('L',(size,size),0); ImageDraw.Draw(m).rounded_rectangle((0,0,size-1,size-1),radius=radius,fill=255); g.putalpha(m)
    return g
def icon(size, scale, radius):
    g=bg(size,radius)
    h=int(size*scale); w=int(half.width*h/half.height)
    ch=half.resize((w,h),Image.LANCZOS)
    layer=Image.new('RGBA',(size,size),(0,0,0,0)); layer.paste(ch,((size-w)//2+int(size*0.03),size-h),ch)
    if radius:  # keep rounded corners
        m=g.split()[3]; la=layer.split()[3]; layer.putalpha(Image.fromarray(np.minimum(np.array(la),np.array(m))))
    return Image.alpha_composite(g,layer)
out='/home/claude/cps-pjo-audit/docs/icons/'
icon(512,0.94,112).save(out+'icon-512.png')
icon(512,0.94,112).resize((192,192),Image.LANCZOS).save(out+'icon-192.png')
icon(512,0.94,112).resize((64,64),Image.LANCZOS).save(out+'favicon-64.png')
icon(512,0.80,0).save(out+'maskable-512.png')
icon(512,0.90,0).resize((180,180),Image.LANCZOS).save(out+'apple-touch-icon.png')
