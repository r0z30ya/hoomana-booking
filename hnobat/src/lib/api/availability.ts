/**
 * Converts API availability input into Prisma create rows.
 * Availability wall times are stored on the 1970-01-01 epoch date and
 * interpreted in the schedule timezone — the same convention cal.com uses.
 */
export interface AvailabilityInput {
  days: number[];
  startTime: string;
  endTime: string;
  date?: Date;
}

export function buildAvailabilityData(availability: AvailabilityInput[]) {
  return availability.map((a) => {
    const [sh, sm] = a.startTime.split(":").map(Number);
    const [eh, em] = a.endTime.split(":").map(Number);
    const data: { days: string; startTime: Date; endTime: Date; date: Date | null } = {
      days: JSON.stringify(a.days),
      startTime: new Date(Date.UTC(1970, 0, 1, sh, sm, 0)),
      endTime: new Date(Date.UTC(1970, 0, 1, eh, em, 0)),
      date: null,
    };
    if (a.date) {
      // date override stored as UTC midnight of that day
      data.date = new Date(Date.UTC(a.date.getUTCFullYear(), a.date.getUTCMonth(), a.date.getUTCDate()));
    }
    return data;
  });
}
