/** Human-facing time, shared by current state and internal-event context. */
export function localMoment(now: number, timezone: string): string {
  const date = new Date(now);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(date),
  );
  const period =
    hour < 5
      ? "凌晨"
      : hour < 9
        ? "早上"
        : hour < 12
          ? "上午"
          : hour < 14
            ? "中午"
            : hour < 18
              ? "下午"
              : hour < 23
                ? "晚上"
                : "深夜";
  return `${date.toLocaleString("sv-SE", { timeZone: timezone }).slice(0, 16)}（${period}，${timezone}）`;
}
