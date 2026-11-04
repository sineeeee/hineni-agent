import { z } from "zod";
import { createHash } from "node:crypto";
export const OnceTasksSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            enabled: z.boolean().default(true),
            at: z.string().datetime({ offset: true }),
            text: z.string().trim().min(1).max(20000),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    for (const t of v.tasks) {
      if (ids.has(t.id))
        ctx.addIssue({ code: "custom", message: "Task IDs must be unique" });
      ids.add(t.id);
    }
  });
export type OnceTask = z.infer<typeof OnceTasksSchema>["tasks"][number];
export function onceEventId(agent: string, task: OnceTask) {
  return (
    "once:" +
    createHash("sha256")
      .update(JSON.stringify([agent, task.id, new Date(task.at).toISOString()]))
      .digest("hex")
  );
}
/** No execution ledger: past deadlines are skipped on start, future deadlines stay absolute. */
export function armOnceTasks(
  tasks: OnceTask[],
  emit: (task: OnceTask) => Promise<void>,
  onError: (e: unknown) => void,
  clock = {
    now: () => Date.now(),
    set: (fn: () => void, ms: number): any => setTimeout(fn, ms),
    clear: (id: any) => clearTimeout(id),
  },
) {
  const timers = new Set<any>();
  const pending = new Set<Promise<void>>();
  let stopped = false;
  const arm = (task: OnceTask) => {
    const timer = clock.set(
      () => {
        timers.delete(timer);
        if (stopped) return;
        if (clock.now() < Date.parse(task.at)) {
          arm(task);
          return;
        }
        const job = emit(task).catch(onError);
        pending.add(job);
        void job.then(
          () => pending.delete(job),
          () => pending.delete(job),
        );
      },
      Math.min(2 ** 31 - 1, Math.max(1, Date.parse(task.at) - clock.now())),
    );
    timers.add(timer);
  };
  for (const task of tasks)
    if (task.enabled && Date.parse(task.at) > clock.now()) arm(task);
  return async () => {
    stopped = true;
    for (const timer of timers) clock.clear(timer);
    timers.clear();
    await Promise.allSettled(pending);
  };
}
