import json,sys
D='/home/user/team-ranks/docs/nfl-draft/data/'
L=json.load(open(D+'leagues.json'));P=json.load(open(D+'players.json'));J=json.load(open(D+'proj.json'))
lg=[e for e in L['leagues'] if e['league']['name']=='Fantasy'][0]['league'];sc=lg['scoring_settings']
def pts(st):
    if not st: return 0.0
    return sum(st.get(k,0)*v for k,v in sc.items() if isinstance(st.get(k),(int,float)))
weeks=[f'2026_w{w}' for w in range(10,19)]
# bye: semana en que el equipo no tiene ningún jugador proyectado
teams_week={}
for k in weeks:
    mx={}
    for pid2,v in J[k].items():
        t=(v or {}).get('_team');mx[t]=max(mx.get(t,0),pts(v))
    teams_week[k]={t for t,m in mx.items() if m>3}
live=json.load(open(D+'live_draft.json'));taken={p['player_id'] for p in live['picks']}
rows=[]
for pid,p in P.items():
    pos=p.get('position');team=p.get('team')
    if pos not in('QB','RB','WR','TE') or not team: continue
    st=J['stats_2026'].get(pid) or {};gp=st.get('gp') or 0;ppg=pts(st)/gp if gp else 0
    wk=[pts(J[k].get(pid)) for k in weeks]
    byes=[int(k.split('w')[1]) for k in weeks if team not in teams_week[k]]
    act=[v for v in wk if v>0.3]; pp=sum(act)/len(act) if act else 0
    if pp<4 and ppg<4: continue
    w_act=0.4 if gp>=4 else 0.4*gp/4
    blend=(1-w_act)*pp+w_act*ppg
    nact=9-len(byes)
    rows.append(dict(pid=pid,name=p.get('full_name'),pos=pos,team=team,inj=p.get('injury_status') or '',gp=gp,ppg=ppg,pp=pp,blend=blend,w10=wk[0],ros=blend*nact,byes=byes,taken=pid in taken))
rep={'QB':10,'RB':27,'WR':30,'TE':10}
for pos,n in rep.items():
    xs=sorted([r for r in rows if r['pos']==pos],key=lambda r:-r['ros'])
    base=xs[n-1]['ros'] if len(xs)>=n else 0
    for i,r in enumerate(xs): r['vor']=r['ros']-base; r['prk']=f"{pos}{i+1}"
rows.sort(key=lambda r:-r['vor'])
json.dump(rows,open(D+'../board.json','w'))
n=int(sys.argv[1]) if len(sys.argv)>1 else 60
for i,r in enumerate([r for r in rows if not r['taken']][:n]):
    print(f"{i+1:3} {r['prk']:5} {r['name'][:22]:22} {r['team']:3} {r['inj'][:4]:4} 26:{r['ppg']:4.1f}({r['gp']:.0f}) proy:{r['pp']:4.1f} w10:{r['w10']:4.1f} bye:{','.join(map(str,r['byes'])) or '-':5} VOR{r['vor']:6.1f}")
