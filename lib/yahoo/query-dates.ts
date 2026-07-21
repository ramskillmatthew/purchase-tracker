const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

function iso(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthRange(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { startDate: iso(year, month, 1)!, endDate: iso(year, month, lastDay)! };
}

export function explicitDateRange(query: string, now = new Date()) {
  const numberWords: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };
  const value = query.toLowerCase().replace(/,/g, " ").replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, word => numberWords[word]).replace(/\s+/g, " ");
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const format = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  const range = (start: Date, end: Date) => ({ startDate: format(start), endDate: format(end) });
  const quantity = value.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(days?|weeks?|months?|years?)\b/);
  if (quantity) {
    const amount = Number(quantity[1]); const unit = quantity[2]; const start = new Date(today);
    if (unit.startsWith("day")) start.setUTCDate(start.getUTCDate() - amount + 1);
    else if (unit.startsWith("week")) start.setUTCDate(start.getUTCDate() - amount * 7 + 1);
    else if (unit.startsWith("month")) start.setUTCMonth(start.getUTCMonth() - amount);
    else start.setUTCFullYear(start.getUTCFullYear() - amount);
    return range(start, today);
  }
  if (/\btoday\b/.test(value)) return range(today, today);
  if (/\byesterday\b/.test(value)) { const date = new Date(today); date.setUTCDate(date.getUTCDate() - 1); return range(date, date); }
  if (/\b(?:this month|month to date|so far this month)\b/.test(value)) return range(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), today);
  // A singular named period is always a completed calendar period. Rolling
  // periods must be explicit (for example "last 30 days" or "last 2 months").
  if (/\b(?:last|past|previous)\s+month\b/.test(value)) return range(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)), new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)));
  if (/\b(?:this week|week to date|so far this week)\b/.test(value)) { const start = new Date(today); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); return range(start, today); }
  if (/\blast week\b/.test(value)) { const end = new Date(today); end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7) - 1); const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6); return range(start, end); }
  if (/\b(?:this year|year to date|so far this year)\b/.test(value)) return range(new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), today);
  if (/\blast year\b/.test(value)) return range(new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)), new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31)));
  // Machine-style and UK numeric ranges.
  const isoRange = value.match(/\b(\d{4})-(\d{2})-(\d{2})\s+(?:to|until|through)\s+(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoRange) { const startDate=iso(+isoRange[1],+isoRange[2],+isoRange[3]), endDate=iso(+isoRange[4],+isoRange[5],+isoRange[6]); return startDate&&endDate&&startDate<=endDate?{startDate,endDate}:null; }
  const ukRange = value.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s+(?:to|until|through|-)\s+(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (ukRange) { const startDate=iso(+ukRange[3],+ukRange[2],+ukRange[1]), endDate=iso(+ukRange[6],+ukRange[5],+ukRange[4]); return startDate&&endDate&&startDate<=endDate?{startDate,endDate}:null; }

  const monthNames = Object.keys(months).join("|");
  const explicitNamedDays = value.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\s+(\\d{4})\\s+(?:to|until|through|-)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\s+(\\d{4})\\b`, "i"));
  if (explicitNamedDays) { const startDate=iso(+explicitNamedDays[3],months[explicitNamedDays[2]],+explicitNamedDays[1]), endDate=iso(+explicitNamedDays[6],months[explicitNamedDays[5]],+explicitNamedDays[4]); return startDate&&endDate&&startDate<=endDate?{startDate,endDate}:null; }
  // Whole calendar months and month-to-month ranges must be recognized before
  // single-day patterns so the first two digits of a year can never become a day.
  const fullMonthRange = value.match(new RegExp(`\\b(${monthNames})\\s+(\\d{4})\\s+(?:to|until|through|-)\\s+(${monthNames})\\s+(\\d{4})\\b`, "i"));
  if (fullMonthRange) { const start=monthRange(+fullMonthRange[2],months[fullMonthRange[1]]), end=monthRange(+fullMonthRange[4],months[fullMonthRange[3]]); return start.startDate<=end.endDate?{startDate:start.startDate,endDate:end.endDate}:null; }
  const sharedYearMonths = value.match(new RegExp(`\\b(${monthNames})\\s+(?:to|until|through|-)\\s+(${monthNames})\\s+(\\d{4})\\b`, "i"));
  if (sharedYearMonths) { const endYear=+sharedYearMonths[3], startMonth=months[sharedYearMonths[1]], endMonth=months[sharedYearMonths[2]], startYear=startMonth>endMonth?endYear-1:endYear; return { startDate:monthRange(startYear,startMonth).startDate, endDate:monthRange(endYear,endMonth).endDate }; }
  const namedMonth = value.match(new RegExp(`\\b(${monthNames})\\s+(\\d{4})\\b`, "i"));
  if (namedMonth) return monthRange(+namedMonth[2], months[namedMonth[1]]);
  const quarter = value.match(/\bq([1-4])\s+(\d{4})\b/i);
  if (quarter) { const first=(+quarter[1]-1)*3+1, year=+quarter[2]; return { startDate:monthRange(year,first).startDate, endDate:monthRange(year,first+2).endDate }; }
  const wholeYear = value.match(/\b(?:in|from|during|for)\s+(20\d{2})\b/);
  if (wholeYear) return { startDate:`${wholeYear[1]}-01-01`, endDate:`${wholeYear[1]}-12-31` };

  const day = "\\b(\\d{1,2})(?:st|nd|rd|th)?\\b";
  const month = `(${Object.keys(months).join("|")})`;
  const separator = "(?:to|until|through|-)";
  const patterns = [
    new RegExp(`${day}\\s+${month}\\s+${separator}\\s+${day}(?:\\s+${month})?(?:\\s+(\\d{4}))?`, "i"),
    new RegExp(`${day}\\s+${separator}\\s+${day}\\s+${month}(?:\\s+(\\d{4}))?`, "i"),
    new RegExp(`${month}\\s+${day}\\s+${separator}\\s+(?:${month}\\s+)?${day}(?:\\s+(\\d{4}))?`, "i"),
    new RegExp(`between\\s+${month}\\s+${day}\\s+and\\s+(?:${month}\\s+)?${day}(?:\\s+(\\d{4}))?`, "i"),
    new RegExp(`between\\s+${day}\\s+${month}\\s+and\\s+${day}(?:\\s+${month})?(?:\\s+(\\d{4}))?`, "i"),
  ];
  for (let index = 0; index < patterns.length; index += 1) {
    const match = value.match(patterns[index]); if (!match) continue;
    let startDay: number; let endDay: number; let startMonth: number; let endMonth: number; let year: number;
    if (index === 0) { startDay = Number(match[1]); startMonth = months[match[2]]; endDay = Number(match[3]); endMonth = months[match[4] || match[2]]; year = Number(match[5] || now.getFullYear()); }
    else if (index === 1) { startDay = Number(match[1]); endDay = Number(match[2]); startMonth = endMonth = months[match[3]]; year = Number(match[4] || now.getFullYear()); }
    else if (index === 2 || index === 3) { startMonth = months[match[1]]; startDay = Number(match[2]); endMonth = months[match[3] || match[1]]; endDay = Number(match[4]); year = Number(match[5] || now.getFullYear()); }
    else { startDay = Number(match[1]); startMonth = months[match[2]]; endDay = Number(match[3]); endMonth = months[match[4] || match[2]]; year = Number(match[5] || now.getFullYear()); }
    const startDate = iso(year, startMonth, startDay); const endDate = iso(year, endMonth, endDay);
    if (startDate && endDate && startDate <= endDate) return { startDate, endDate };
  }
  if (/\b(?:between|to|until|through|and)\b/.test(value)) return null;
  const singlePatterns = [
    new RegExp(`(?:on\\s+|the\\s+)?${day}\\s+${month}(?:\\s+(\\d{4}))?`, "i"),
    new RegExp(`(?:on\\s+|the\\s+)?${month}\\s+${day}(?:\\s+(\\d{4}))?`, "i"),
  ];
  for (let index = 0; index < singlePatterns.length; index += 1) {
    const match = value.match(singlePatterns[index]); if (!match) continue;
    const date = index === 0
      ? iso(Number(match[3] || now.getFullYear()), months[match[2]], Number(match[1]))
      : iso(Number(match[3] || now.getFullYear()), months[match[1]], Number(match[2]));
    if (date) return { startDate: date, endDate: date };
  }
  const singleIso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (singleIso) { const date=iso(+singleIso[1],+singleIso[2],+singleIso[3]); return date?{startDate:date,endDate:date}:null; }
  const singleUk = value.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/); if (singleUk) { const date=iso(+singleUk[3],+singleUk[2],+singleUk[1]); return date?{startDate:date,endDate:date}:null; }
  return null;
}
