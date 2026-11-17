import esprima,re
from pathlib import Path
s=Path('app/app.js').read_text(encoding='utf-8')
s=s.replace('listener?.(','listener(').replace('?.','.').replace('??','||').replace('catch {','catch (e) {')
s=re.sub(r'(?<=\d)_(?=\d)','',s)
tokens=esprima.tokenize(s,{'tolerant':True,'loc':True})
stack=[]; pairs={'}':'{',')':'(',']':'['}; opens={'{','(','['}
for t in tokens:
    v=t.value
    if v in opens: stack.append((v,t.loc.start.line,t.loc.start.column))
    elif v in pairs:
        if not stack or stack[-1][0]!=pairs[v]:
            print('MISMATCH',v,t.loc.start.line,stack[-5:]); break
        stack.pop()
print('remaining',stack[-20:]); print('count',len(stack))
