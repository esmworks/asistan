import { useEffect, useState } from 'react';

/** Where a snoozed conversation comes back: in an hour, tomorrow morning, or next Monday morning. */
export type SnoozeKey = 'hour' | 'tomorrow' | 'nextWeek';

/** The snooze choices from `now`, in this device's time: mornings are at 9:00. */
export function snoozeTimes(now: Date): { key: SnoozeKey; at: Date }[] {
  const morning = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d;
  };
  // Days to the coming Monday; a week on when today is Monday.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { key: 'hour', at: new Date(now.getTime() + 60 * 60_000) },
    { key: 'tomorrow', at: morning(1) },
    { key: 'nextWeek', at: morning(toMonday) },
  ];
}

/** The time now, renewed every minute, so a snooze that runs out while the page is open ends there. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
