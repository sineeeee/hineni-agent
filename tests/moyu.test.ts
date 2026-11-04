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
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
import dice,fetch
with tempfile.TemporaryDirectory() as folder:
 b=Path(folder)
 for name in ['config.json','dice.py']:
  shutil.copy(Path(sys.argv[1])/name,b/name)
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
 subprocess.run([sys.executable,str(b/'dice.py'),'preview'],check=True,capture_output=True)
 assert (b/'state.json').read_bytes()==before
 assert fetch.parse_feed('p',b'<rss><channel><item><title>test</title><link>https://example.com/a</link><description>summary</description></item></channel></rss>')[0]['content_scope']=='feed_excerpt'
 assert fetch.parse_feed('p',b'<rss><channel><item><title>test</title><link>https://example.com/a</link></item></channel></rss>')[0]['content_scope']=='title_only'
 source={'kind':'opencli','platform':'instagram','command':'explore'}
 with patch('fetch.shutil.which',return_value='/bin/opencli'), patch('fetch.subprocess.run',return_value=subprocess.CompletedProcess([],0,json.dumps({'ok':True,'data':[{'caption':'real text','user':'author'}]}),'')) as mocked:
  items=fetch.browser_collect('ig',source,4,b)
  assert items[0]['url'] is None and items[0]['excerpt']=='real text'
  assert mocked.call_args.args[0][1:3]==['instagram','explore']
 try:
  fetch.browser_collect('ig',{'platform':'instagram','command':'comment'},4,b)
  raise AssertionError('write command accepted')
 except ValueError: pass
 failure=fetch.run(['d','p'],b,lambda *args: (_ for _ in ()).throw(ValueError('offline')))
 assert all(s['status']=='fail' and s['items']==[] for s in failure['sources'])
 assert (b/'last-edition.json').exists()
print('passed')
`,
      path.resolve("templates/activities/moyu"),
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.match(stdout, /passed/);
});
