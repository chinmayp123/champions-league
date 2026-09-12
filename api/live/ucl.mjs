// Vercel live function for the Champions League: GET /api/live/ucl?q=<espnEventId>. See ../_live.mjs.
// The data layer picks its competition once, when it loads, so every competition is its own
// function (its own instances) and sets COMPETITION before loading it.
export async function GET(request) {
  process.env.COMPETITION ||= "ucl";
  return (await import("../_live.mjs")).GET(request);
}
