import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
test("Skill dice returns readable source URLs and preview stays read-only", async () => {
  const { stdout } = await run(
    "python3",
    [
      "-c",
      `
import sys,tempfile,shutil,json,random,subprocess
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/"scripts"))
import dice
with tempfile.TemporaryDirectory() as folder:
 b=Path(folder)
 shutil.copytree(sys.argv[1],b,dirs_exist_ok=True)
 cfg=dice.RULES;assert not (b/'config.json').exists()
 state=dice.current_state(b);rng=random.Random(3)
 first=dice.decide(cfg,state,rng);second=dice.decide(cfg,state,rng)
 assert not set(x['id'] for x in first['sources']) & set(x['id'] for x in second['sources'])
 assert state['rolls']==2 and 'opportunities' not in state
 dice.atomic_json(b/'state.json',state)
 before=(b/'state.json').read_bytes()
 subprocess.run([sys.executable,str(b/'scripts/dice.py'),'preview'],check=True,capture_output=True)
 assert (b/'state.json').read_bytes()==before
 assert all(x['url'].startswith('https://') and x['kind'] for x in first['sources'])
 assert not (b/'scripts/fetch.py').exists()
 assert cfg['sources']['blog']['enabled'] is False
 cfg['sources']={'blog':{'name':'blog','enabled':True,'kind':'wordpress','url':'https://example.com/feed/'}}
 assert dice.decide(cfg,{},rng)['sources'][0]['url']=='https://example.com/feed/'
print('passed')
`,
      path.resolve("templates/skills/moyu"),
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.match(stdout, /passed/);
});

test("scheduler owns weighted modes, daily quota and restart-safe counting", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { takeLeisureOpportunity } = await import("../src/shared/leisure.js");
  const { ConfigSchema } = await import("../src/config/schema.js");
  const dir = await fs.mkdtemp(path.join(tmpdir(), "leisure-"));
  try {
    const file = path.join(dir, "state.json");
    const cfg = ConfigSchema.shape.scheduler.parse({ leisureDailyLimit: 3 });
    const day = new Date("2026-11-04T02:00:00Z");
    assert.equal(await takeLeisureOpportunity(file, cfg, day, () => 0), "moyu");
    assert.equal(
      await takeLeisureOpportunity(file, cfg, day, () => 0.7),
      "chat",
    );
    assert.equal(
      await takeLeisureOpportunity(file, cfg, day, () => 0.9),
      "quiet",
    );
    assert.equal(
      await takeLeisureOpportunity(file, cfg, day, () => 0),
      "quiet",
    );
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).opportunities, 3);
    assert.equal(
      await takeLeisureOpportunity(
        file,
        cfg,
        new Date("2026-11-04T16:01:00Z"),
        () => 0,
      ),
      "moyu",
    );
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).opportunities, 1);
    const beforeUnlimited = await fs.readFile(file, "utf8");
    for (let i = 0; i < 10; i++) {
      assert.equal(
        await takeLeisureOpportunity(
          file,
          {
            ...cfg,
            leisureDailyLimit: 0,
            moyuWeight: 68,
            chatWeight: 32,
            quietWeight: 0,
          },
          day,
          () => 0.67,
        ),
        "moyu",
      );
      assert.equal(
        await takeLeisureOpportunity(
          file,
          {
            ...cfg,
            leisureDailyLimit: 0,
            moyuWeight: 68,
            chatWeight: 32,
            quietWeight: 0,
          },
          day,
          () => 0.68,
        ),
        "chat",
      );
    }
    assert.equal(await fs.readFile(file, "utf8"), beforeUnlimited);
    assert.equal(
      await takeLeisureOpportunity(
        file,
        { ...cfg, moyuWeight: 0, chatWeight: 0, quietWeight: 0 },
        day,
      ),
      "quiet",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
