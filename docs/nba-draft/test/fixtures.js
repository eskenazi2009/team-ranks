// Datos simulados con la forma real de las respuestas de Sleeper / ESPN
const U = 'u_ray';
const users = ['u_ray','u_a','u_b','u_c','u_d','u_e','u_f','u_g','u_h','u_i'];
const names = ['Raymond','Ana','Beto','Caro','Dani','Eli','Fer','Gaby','Hugo','Ivy'];
const league = {
  league_id: 'L1', name: 'Benchwarmers', season: '2026', total_rosters: 10, status: 'pre_draft',
  scoring_settings: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1, tpm: 0.5, fgmi: -0.5, ftmi: -0.5, dd: 2, td: 5 },
  roster_positions: ['PG','SG','SF','PF','C','G','F','UTIL','UTIL','BN','BN','BN','IR'],
  settings: { type: 0, playoff_teams: 6, playoff_week_start: 20, waiver_type: 2, waiver_budget: 100 },
};
const draft_order = Object.fromEntries(users.map((u,i)=>[u,i+1]));
const slot_to_roster_id = Object.fromEntries(users.map((u,i)=>[i+1,i+1]));
const draft = { draft_id:'D1', league_id:'L1', status:'drafting', type:'snake', season:'2026', start_time: Date.now()-600000, last_picked: Date.now()-20000,
  settings:{ rounds:12, teams:10, pick_timer:90 }, draft_order, slot_to_roster_id, metadata:{scoring_type:'points'} };
// jugadores
const P = [
 ['p1','Nikola','Jokic','DEN','C',['C'],5,  {gp:70,min:2450,pts:2050,reb:900,ast:720,stl:120,blk:50,to:230,tpm:120,tpa:300,fgm:760,fga:1310,ftm:410,fta:510,dd:60,td:30}],
 ['p2','Luka','Doncic','LAL','PG',['PG','SG'],9, {gp:50,min:1800,pts:1420,reb:410,ast:390,stl:90,blk:20,to:190,tpm:170,tpa:470,fgm:470,fga:1030,ftm:310,fta:400,dd:25,td:8}],
 ['p3','Shai','Gilgeous-Alexander','OKC','PG',['PG'],1, {gp:76,min:2600,pts:2480,reb:380,ast:490,stl:130,blk:80,to:180,tpm:150,tpa:400,fgm:890,fga:1700,ftm:550,fta:610,dd:10,td:1}],
 ['p4','Giannis','Antetokounmpo','MIL','PF',['PF','C'],2, {gp:67,min:2300,pts:2050,reb:800,ast:430,stl:60,blk:80,to:210,tpm:10,tpa:50,fgm:800,fga:1330,ftm:430,fta:710,dd:50,td:7}],
 ['p5','Victor','Wembanyama','SAS','C',['C','PF'],4, {gp:46,min:1530,pts:1110,reb:510,back:0,ast:170,stl:50,blk:175,to:150,tpm:110,tpa:310,fgm:400,fga:830,ftm:200,fta:240,dd:30,td:3}],
 ['p6','Jayson','Tatum','BOS','SF',['SF','PF'],6, {gp:72,min:2600,pts:1930,reb:630,ast:430,stl:80,blk:40,to:210,tpm:230,tpa:670,fgm:660,fga:1460,ftm:380,fta:470,dd:30,td:2}],
 ['p7','Anthony','Edwards','MIN','SG',['SG','SF'],8, {gp:79,min:2860,pts:2180,reb:450,ast:360,stl:90,blk:40,to:250,tpm:320,tpa:810,fgm:720,fga:1620,ftm:420,fta:500,dd:8,td:0}],
 ['p8','Tyrese','Haliburton','IND','PG',['PG'],20, {gp:73,min:2420,pts:1350,reb:260,ast:670,stl:100,blk:50,to:120,tpm:200,tpa:520,fgm:480,fga:1020,ftm:190,fta:220,dd:25,td:1}],
 ['p9','Jalen','Brunson','NYK','PG',['PG','SG'],14, {gp:65,min:2300,pts:1690,reb:190,ast:480,stl:60,blk:10,to:170,tpm:170,tpa:440,fgm:600,fga:1230,ftm:320,fta:390,dd:5,td:0}],
 ['p10','Bam','Adebayo','MIA','C',['C'],30, {gp:78,min:2630,pts:1420,reb:750,ast:340,stl:100,blk:60,to:170,tpm:60,tpa:170,fgm:540,fga:1120,ftm:280,fta:370,dd:35,td:1}],
 ['p11','Evan','Mobley','CLE','PF',['PF','C'],22, {gp:71,min:2160,pts:1320,reb:650,ast:230,stl:60,blk:110,to:120,tpm:60,tpa:160,fgm:530,fga:950,ftm:200,fta:270,dd:28,td:0}],
 ['p12','Derrick','White','BOS','SG',['SG','PG'],45, {gp:76,min:2500,pts:1260,reb:340,ast:360,stl:70,blk:90,to:110,tpm:260,tpa:680,fgm:430,fga:960,ftm:140,fta:170,dd:3,td:0}],
 ['p13','Franz','Wagner','ORL','SF',['SF'],25, {gp:60,min:2000,pts:1450,reb:340,ast:280,stl:90,blk:30,to:150,tpm:100,tpa:330,fgm:520,fga:1100,ftm:310,fta:370,dd:4,td:0}],
 ['p14','Paolo','Banchero','ORL','PF',['PF','SF'],18, {gp:46,min:1600,pts:1180,reb:340,ast:210,stl:40,blk:20,to:150,tpm:60,tpa:190,fgm:410,fga:910,ftm:300,fta:400,dd:8,td:0}],
 ['p15','Kawhi','Leonard','LAC','SF',['SF','PF'],60, {gp:37,min:1200,pts:790,reb:220,ast:110,stl:60,blk:20,to:60,tpm:70,tpa:170,fgm:290,fga:580,ftm:140,fta:170,dd:2,td:0}],
 ['p16','Rookie','Nuevo','POR','SG',['SG'],300, null],
];
const players = {};
for (const [id,fn,ln,team,pos,fp,rank,st] of P) players[id] = { player_id:id, first_name:fn, last_name:ln, team, position:pos, fantasy_positions:fp, status:'Active', active:true, age:26, years_exp:5, search_rank:rank, espn_id: 100000+Number(id.slice(1)), number:7, injury_status: id==='p15'?'Out':(id==='p2'?'Questionable':null), injury_body_part: id==='p15'?'Knee':(id==='p2'?'Calf':null) };
const stats = P.filter(x=>x[7]).map(([id,,,team,,,,st])=>({ player_id:id, season:'2025', season_type:'regular', team, stats: st }));
const proj = P.filter(x=>x[7]).map(([id,,,team,,,,st])=>({ player_id:id, season:'2026', season_type:'regular', team, stats: Object.fromEntries(Object.entries(st).map(([k,v])=>[k, k==='gp'?70: v/(st.gp||70)*70])) }));
// picks: 13 ya hechos (Ray es slot 1: picks 1 y 20; su siguiente es #21)
const order=[]; for(let r=1;r<=12;r++){const s=[...Array(10)].map((_,i)=>i+1); if(r%2===0)s.reverse(); for(const x of s) order.push({round:r,slot:x});}
const takenIds=['p3','p1','p4','p6','p7','p2','p8','p9','p10','p11','p12','p13','p14'];
const picks = takenIds.map((pid,i)=>{const o=order[i]; const p=players[pid]; return { round:o.round, pick_no:i+1, draft_slot:o.slot, roster_id:o.slot, picked_by:users[o.slot-1], player_id:pid, metadata:{first_name:p.first_name,last_name:p.last_name,position:p.position,team:p.team} };});
module.exports = {
  'api.sleeper.app/v1/state/nba': { season:'2026', league_season:'2026', season_type:'pre', previous_season:'2025' },
  'api.sleeper.app/v1/user/raymondesk': { user_id:U, username:'raymondesk', display_name:'raymondesk' },
  'api.sleeper.app/v1/user/u_ray/leagues/nba/2026': [league],
  'api.sleeper.app/v1/league/L1/users': users.map((u,i)=>({user_id:u, display_name:names[i], metadata:{team_name: names[i]+"'s Team"}})),
  'api.sleeper.app/v1/league/L1/rosters': users.map((u,i)=>({roster_id:i+1, owner_id:u, players:[]})),
  'api.sleeper.app/v1/league/L1/drafts': [draft],
  'api.sleeper.app/v1/draft/D1': draft,
  'api.sleeper.app/v1/draft/D1/traded_picks': [],
  'api.sleeper.app/v1/draft/D1/picks': picks,
  'api.sleeper.app/v1/players/nba': players,
  'api.sleeper.com/stats/nba/2025': stats,
  'api.sleeper.com/projections/nba/2026': proj,
  'site.api.espn.com/apis/site/v2/sports/basketball/nba/teams': { sports:[{leagues:[{teams:[{team:{id:'25',abbreviation:'OKC',displayName:'Thunder'}},{team:{id:'14',abbreviation:'MIN'}},{team:{id:'24',abbreviation:'SA',displayName:'Spurs'}}]}]}] },
  'site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries': { injuries:[{displayName:'Clippers', injuries:[{athlete:{id:'100015'}, status:'Out', details:{type:'Knee', detail:'Rodilla derecha, sin fecha de regreso', returnDate:'2026-12-01'}}]}] },
  'site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/24/roster': { athletes:[{id:'100005',displayName:'Victor Wembanyama',position:{abbreviation:'C'},age:25,experience:{years:6},injuries:[]},{id:'999',displayName:'Rudy Gobert',position:{abbreviation:'C'},age:34,experience:{years:12},injuries:[{status:'Day-To-Day'}]}] },
  'site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/100005/overview': { news:[{headline:'Edwards anota 40 en la pretemporada', description:'Gran noche.', published:'2026-10-15T00:00:00Z', links:{web:{href:'https://espn.com/x'}}}] },
  'site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/100005/stats': { categories:[{name:'averages', labels:['GP','GS','MIN','FG%','3P%','FT%','REB','AST','BLK','STL','PF','TO','PTS','3PM'], statistics:[{season:{year:2024,displayName:'2023-24'},teamSlug:'minnesota-timberwolves',stats:['79','79','35.1','46.1','35.7','83.6','5.4','5.1','0.5','1.3','1.8','3.1','25.9','3.1']},{season:{year:2025,displayName:'2024-25'},teamSlug:'minnesota-timberwolves',stats:['79','79','36.3','44.7','39.5','83.7','5.7','4.5','0.6','1.2','1.9','3.2','27.6','4.1']}]}] },
};
