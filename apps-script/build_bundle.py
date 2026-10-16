"""Builds dist/: 4 files to paste into the Apps Script editor (Code.gs, Seed.gs, Index.html, appsscript.json)."""
import os, re, shutil
S = os.path.join(os.path.dirname(__file__), 'src'); D = os.path.join(os.path.dirname(__file__), 'dist')
shutil.rmtree(D, ignore_errors=True); os.makedirs(D)
read = lambda n: open(os.path.join(S, n), encoding='utf-8').read()
code = ''.join(f'// ===== {n} =====\n' + read(n) + '\n' for n in ['Store.gs', 'Auth.gs', 'Logic.gs', 'Api.gs', 'Plan.gs', 'Retention.gs', 'CpsExport.gs', 'Code.gs'])
open(os.path.join(D, 'Code.gs'), 'w', encoding='utf-8').write(code)
shutil.copy(os.path.join(S, 'Seed.gs'), D); shutil.copy(os.path.join(S, 'appsscript.json'), D)
idx = re.sub(r"<\?!= include\('(\w+)'\) \?>", lambda m: read(m.group(1) + '.html'), read('Index.html'))
assert '<?' not in idx
open(os.path.join(D, 'Index.html'), 'w', encoding='utf-8').write(idx)
print(sorted(os.listdir(D)))
