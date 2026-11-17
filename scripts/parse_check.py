import esprima,re
from pathlib import Path
s=Path('app/app.js').read_text(encoding='utf-8')
s=s.replace('listener?.(','listener(').replace('?.','.').replace('??','||').replace('catch {','catch (e) {')
s=re.sub(r'(?<=\d)_(?=\d)','',s)
try:
    esprima.parseModule(s)
    print('ok')
except Exception as e:
    print(str(e))
    print('line',getattr(e,'lineNumber',None),'col',getattr(e,'column',None))
