import sys,re,json,shutil,os
S,R=sys.argv[1:]; E=R+'/extension'
s=open(S+'/sticky-desk.html').read()
s=re.sub(r'<link rel="(apple-touch-icon|manifest)"[^>]*>\n','',s)
s=s.replace('<link rel="icon" type="image/png" href="icon-192.png">','<link rel="icon" type="image/png" href="icons/32.png">')
s=s.replace('<script src="https://unpkg.com/adhan@4.4.3/lib/bundles/adhan.umd.min.js"></script>','<script src="adhan.js"></script>')
s=s.replace(' onsubmit="return false"','')
m=re.findall(r'<script>(.*?)</script>',s,re.S); assert len(m)==1
app=m[0]; s=s.replace('<script>'+app+'</script>','<script src="app.js"></script>')
app='document.getElementById("si-form").addEventListener("submit", (e) => e.preventDefault());\n'+app
a="""'w.url = "' + location.origin + '";',"""; assert a in app
app=app.replace(a,"""'w.url = "' + (location.protocol.startsWith("http") ? location.origin : "https://sticky-desk-ochre.vercel.app") + '";',""")
assert 'src="adhan.js"' in s and not re.search(r' on[a-z]+="',s)
head='<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<style>body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
open(E+'/board.html','w').write(head+s+'\n</body>\n</html>\n'); open(E+'/app.js','w').write(app)
mp=E+'/manifest.json'; m=json.load(open(mp)); v=m['version'].split('.'); v[-1]=str(int(v[-1])+1); m['version']='.'.join(v); json.dump(m,open(mp,'w'),indent=2); print('version',m['version'])
