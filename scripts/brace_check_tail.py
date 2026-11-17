from pathlib import Path
s=Path('app/app.js').read_text(encoding='utf-8')
start=s.index('  els.appTabs.addEventListener')
s=s[start:]
stack=[]; pairs={'}':'{',')':'(',']':'['}; line=860; i=0; state='normal'
while i<len(s):
 c=s[i]; n=s[i+1] if i+1<len(s) else ''
 if c=='\n': line+=1
 if state=='normal':
  if c=='/' and n=='/': state='line'; i+=1
  elif c=='/' and n=='*': state='block'; i+=1
  elif c=="'": state='single'
  elif c=='"': state='double'
  elif c=='`': state='template'
  elif c in '{([': stack.append((c,line,i))
  elif c in '})]':
   if not stack or stack[-1][0]!=pairs[c]: print('MISMATCH',c,line,stack[-3:]); break
   stack.pop()
 elif state=='line':
  if c=='\n': state='normal'
 elif state=='block':
  if c=='*' and n=='/': state='normal'; i+=1
 elif state in ('single','double'):
  if c=='\\': i+=1
  elif (state=='single' and c=="'") or (state=='double' and c=='"'): state='normal'
 elif state=='template':
  if c=='\\': i+=1
  elif c=='`': state='normal'
 i+=1
print('state',state,'remaining',stack[-12:])
print('open',len(stack))
