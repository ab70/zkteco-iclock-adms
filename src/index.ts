import { Elysia } from "elysia";
import swagger from "@elysiajs/swagger";

const PORT = 3000;
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain" } });
const commandQueue = new Map<string, Array<{ id: number; cmd: string }>>();
let cmdCounter = 1;

const formatDeviceTime = () => {
  const now = new Date();
  const offMin = -now.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offMin) % 60).padStart(2, "0");
  const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
  return `Time=${localIso}${sign}${hh}:${mm}`;
};

const pad = (n: number) => String(n).padStart(2, "0");
const zkDateTime = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const queueCommand = (sn: string, cmd: string) => {
  if (!commandQueue.has(sn)) commandQueue.set(sn, []);
  const id = cmdCounter++;
  commandQueue.get(sn)!.push({ id, cmd });
  console.log(`\n[CMD] Queued for ${sn}: [${id}] ${cmd}`);
  return id;
};

const queueAttlogRange = (sn: string, start: Date, end: Date) =>
  queueCommand(
    sn,
    `DATA QUERY ATTLOG StartTime=${zkDateTime(start)}\tEndTime=${zkDateTime(end)}`
  );

const parseATTLOG = (raw: string) =>
  raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pin, date, time, status, verify, workcode] = line.trim().split(/\t+|\s+/);
      return {
        pin,
        datetime: date && time ? `${date} ${time}` : date,
        status,
        verify,
        workcode,
        raw: line
      };
    });

const app = new Elysia()
  .use(swagger({
    path: "/swagger",
    documentation: {
      info: { title: "ZK ADMS API", version: "1.0.0" }
    }
  }))
  .post("/api/cmd", async ({ body }) => {
    const { sn, command } = body as { sn: string; command: string };
    if (!sn || !command) return text("Missing sn or command", 400);
    const id = queueCommand(sn, command);
    return { status: "queued", id, command };
  })
  .post("/api/attlog/last2days", ({ body }) => {
    const { sn, start, end } = body as { sn?: string; start?: string; end?: string };
    if (!sn) return text("Missing sn", 400);

    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    if (!startDate || Number.isNaN(startDate.getTime()) || !endDate || Number.isNaN(endDate.getTime())) {
      return text("Missing or invalid start/end", 400);
    }

    const id = queueAttlogRange(sn, startDate, endDate);
    return {
      status: "queued",
      id,
      sn,
      range: `${startDate.toISOString()} -> ${endDate.toISOString()}`
    };
  })
  .get("/iclock/cdata", ({ query }) => {
    console.log("\n=== GET /iclock/cdata", new Date().toISOString(), "===");
    console.log("Query:", JSON.stringify(query, null, 2));

    const { SN, type, options } = query;
    if (type === "time") return text(formatDeviceTime());

    if (options) {
      return text([
        `GET OPTION FROM: ${SN || "UNKNOWN"}`,
        "Stamp=9999",
        "OpStamp=9999",
        "PhotoStamp=9999",
        "ErrorDelay=60",
        "Delay=30",
        "TransTimes=00:00;23:59",
        "TransInterval=1",
        "TransFlag=1111000000",
        "Realtime=1",
        "Encrypt=0",
        "PushProtVer=2.4.1"
      ].join("\n"));
    }

    return text("OK");
  })
  .get("/iclock/getrequest", ({ query, path }) => {
    const { SN } = query;
    console.log("\n=== GET", path, new Date().toISOString(), "===");
    console.log("Device checking for commands:", SN);

    const queue = SN ? commandQueue.get(SN) : undefined;
    if (queue?.length) {
      const cmdsToSend = queue.splice(0, queue.length);
      const payload = cmdsToSend.map((c) => `C:${c.id}:${c.cmd}`).join("\n");
      console.log(`[CMD] Sending to ${SN}:\n${payload}`);
      return text(payload);
    }

    return text("OK");
  })
  .post("/iclock/devicecmd", async ({ request }) => {
    console.log("\n=== POST /iclock/devicecmd (Command Result) ===");
    console.log("Result Body:", await request.text());
    return text("OK");
  })
  .get("/iclock/ping", ({ query, path }) => {
    console.log("\n=== GET", path, new Date().toISOString(), "===");
    console.log("Query:", JSON.stringify(query, null, 2));
    return text("OK");
  })
  .post("/iclock/cdata", async ({ query, request }) => {
    console.log("\n=== POST /iclock/cdata", new Date().toISOString(), "===");
    console.log("Query:", JSON.stringify(query, null, 2));

    const raw = await request.text();
    const table = (query.table as string | undefined)?.toUpperCase() || "";

    if (table === "ATTLOG") {
      const records = parseATTLOG(raw);
      console.log("Parsed ATTLOG records:", records);
      return text(`OK:${records.length}`);
    }

    if (table === "USERINFO") {
      console.log("Received USERINFO:");
      console.log(raw);
      const lines = raw.trim().split(/\r?\n/);
      console.log(`Received ${lines.length} users.`);
      return text(`OK:${lines.length}`);
    }

    if (table === "OPERLOG") {
      console.log("OPERLOG received (user/template/system logs).");
      return text("OK");
    }

    if (table === "ATTPHOTO") {
      console.log("ATTPHOTO received (photo/base64).");
      return text("OK");
    }

    return text("OK");
  })
  .listen(PORT);

console.log(`\nADMS/PUSH server listening on http://0.0.0.0:${PORT}`);
