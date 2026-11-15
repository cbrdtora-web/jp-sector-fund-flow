"""Artifactのローソク足用 data/chart/recent.json を data/prices から再生成する。
使い方: python3 scripts/build_chart_recent.py <現在公開中のrecent.json> <出力先recent.json>
(先頭の日付・scale・volume単位は現在公開中のファイルを引き継ぐ)"""
import json,sys,csv,os
old=json.load(open(sys.argv[1]))
P=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","data","prices")+"/"
first=old['dates'][0]
rows={}
alld=set()
for fn in os.listdir(P):
    code=fn[:-4]; r=[]
    for l in csv.DictReader(open(P+fn)):
        if l['Date']>=first and l['Close']!='' :
            r.append((l['Date'],float(l['Open']),float(l['High']),float(l['Low']),float(l['Close']),float(l['Volume'])))
            alld.add(l['Date'])
    rows[code]=r
dates=sorted(alld)
print(dates)
vu=old['vu']
def enc(r):
    m={x[0]:x for x in r}
    ds=[d for d in dates if d in m]
    if not ds: return None
    vals=[v for x in r for v in x[1:5]]
    sc=1
    for s in (1,10,100):
        if all(abs(v*s-round(v*s))<1e-6 for v in vals): sc=s;break
    else: sc=100
    start=dates.index(ds[0]); out=[sc,start]; c0=0
    for d in dates[start:]:
        if d in m:
            _,o,h,l,c,v=m[d]; o,h,l,c=[round(t*sc) for t in (o,h,l,c)]
            out+= [c-c0,o-c,h-max(o,c),min(o,c)-l,round(v/vu)]; c0=c
        else: out+=[0,0,0,0,0]
    return out
new={}
for code,r in rows.items():
    e=enc(r)
    if e: new[code]=e
# validate against old on overlapping dates
bad=0;cmp=0
oi={d:i for i,d in enumerate(old['dates'])}
for code,o in old['d'].items():
    n=new.get(code)
    if not n: bad+=1;continue
    # compare first 18 days values
    a=o[2:]; b=n[2:]
    L=min(len(a),len(b)-5 if len(b)>len(a) else len(b))
    cmp+=1
    if n[0]!=o[0] or n[1]!=o[1] or a[:L]!=b[:L]: bad+=1
print("compared",cmp,"mismatch",bad,"new codes",len(new))
json.dump({"v":old['v'],"vu":vu,"asof":dates[-1],"dates":dates,"d":new},open(sys.argv[2],"w"),separators=(',',':'),ensure_ascii=False)
