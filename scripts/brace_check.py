from pathlib import Path
s=Path('app/app.js').read_text(encoding='utf-8')
stack=[]
pairs={'}':'{',')':'(',']':'['}
line=1; i=0; state='normal'; last_sig=''
def regex_allowed(prev):
    return prev=='' or prev in '=(:,![{;?&|+-*%<>~^'
while i<len(s):
    c=s[i]; n=s[i+1] if i+1<len(s) else ''
    if c=='\n': line+=1
    if state=='normal':
        if c=='/' and n=='/': state='line'; i+=1
        elif c=='/' and n=='*': state='block'; i+=1
        elif c=='/' and regex_allowed(last_sig): state='regex'; i+=1
        elif c=="'": state='single'; last_sig=c
        elif c=='"': state='double'; last_sig=c
        elif c=='`': state='template'; last_sig=c
        elif c in '{([': stack.append((c,line,i)); last_sig=c
        elif c in '})]':
            if not stack or stack[-1][0]!=pairs[c]:
                print('MISMATCH',c,'line',line,'top',stack[-1] if stack else None); break
            stack.pop(); last_sig=c
        elif not c.isspace(): last_sig=c
    elif state=='line':
        if c=='\n': state='normal'
    elif state=='block':
        if c=='*' and n=='/': state='normal'; i+=1
    elif state=='regex':
        if c=='\\': i+=1
        elif c=='[': state='regexclass'
        elif c=='/': state='normal'; last_sig='/'
    elif state=='regexclass':
        if c=='\\': i+=1
        elif c==']': state='regex'
    elif state in ('single','double'):
        if c=='\\': i+=1
        elif (state=='single' and c=="'") or (state=='double' and c=='"'): state='normal'; last_sig=c
    elif state=='template':
        if c=='\\': i+=1
        elif c=='`': state='normal'; last_sig=c
    i+=1
print('state',state,'remaining',stack[-12:])
print('open count',len(stack))
