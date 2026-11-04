import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
test("leisure dice keeps quotas, source diversity and read-only preview; readers preserve scope", async () => {
  const { stdout } = await run(
    "python3",
    [
      "-c",
      `
import sys,tempfile,shutil,json,random,subprocess
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/"scripts"))
import dice,fetch
with tempfile.TemporaryDirectory() as folder:
 b=Path(folder)
 shutil.copytree(sys.argv[1],b,dirs_exist_ok=True)
 cfg=dice.read_config(b);cfg['weights']={'moyu':1,'chat':0,'quiet':0}
 state=dice.current_state(b,'2026-11-04');rng=random.Random(3)
 first=dice.decide(cfg,state,rng);second=dice.decide(cfg,state,rng)
 assert not set(x['id'] for x in first['sources']) & set(x['id'] for x in second['sources'])
 for _ in range(20): dice.decide(cfg,state,rng)
 assert state['opportunities']==cfg['dailyOpportunities']
 assert dice.decide(cfg,state,rng)['reason']=='daily_limit'
 assert dice.decide(cfg,state,rng,True)['kind']=='moyu'
 assert state['opportunities']==cfg['dailyOpportunities']
 dice.atomic_json(b/'state.json',state)
 assert dice.current_state(b,'2026-11-05')['opportunities']==0
 before=(b/'state.json').read_bytes()
 subprocess.run([sys.executable,str(b/'scripts/dice.py'),'preview'],check=True,capture_output=True)
 assert (b/'state.json').read_bytes()==before
 assert fetch.parse_feed('p',b'<rss><channel><item><title>test</title><link>https://example.com/a</link><description>summary</description></item></channel></rss>')[0]['content_scope']=='feed_excerpt'
 assert fetch.parse_feed('p',b'<rss><channel><item><title>test</title><link>https://example.com/a</link></item></channel></rss>')[0]['content_scope']=='title_only'
 assert all(x['kind'] in {'rss','hn','lobsters','v2ex','bluesky'} for x in cfg['sources'].values())
 assert 'browser' not in cfg
 success=fetch.run(['h'],b,lambda *args: json.dumps([{'title':'real title','url':'https://example.com/post','content':'real excerpt'}]).encode())
 assert success['sources'][0]['items'][0]['excerpt']=='real excerpt'
 failure=fetch.run(['d','p'],b,lambda *args: (_ for _ in ()).throw(ValueError('offline')))
 assert all(s['status']=='fail' and s['items']==[] for s in failure['sources'])
 assert (b/'last-edition.json').exists()
print('passed')
`,
      path.resolve("templates/skills/moyu"),
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.match(stdout, /passed/);
});
