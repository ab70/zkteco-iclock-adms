import { Elysia } from "elysia";
import swagger from "@elysiajs/swagger";

const PORT = 5002;

// --- Helpers ---
function formatDeviceTime() {
  const now = new Date();

  // local offset, e.g. Asia/Dhaka = +06:00
  const offMin = -now.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offMin) % 60).padStart(2, "0");

  // "local ISO" without Z
  const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);

  return `Time=${localIso}${sign}${hh}:${mm}`;
}
function pad(n: number) {
  return String(n).padStart(2, "0");
}

// ZK wants: YYYY-MM-DD HH:mm:ss
function zkDateTime(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function queueCommand(sn: string, command: string) {
  if (!commandQueue.has(sn)) commandQueue.set(sn, []);
  const id = cmdCounter++;
  commandQueue.get(sn)!.push({ id, cmd: command });
  console.log(`\n[CMD] Queued for ${sn}: [${id}] ${command}`);
  return id;
}

function queueLastTwoDaysAttlog(sn: string) {
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 24 * 60 * 60 * 1000); // last 48 hours

  // IMPORTANT: TAB between StartTime and EndTime
  const cmd =
    `DATA QUERY ATTLOG StartTime=${zkDateTime(start)}\tEndTime=${zkDateTime(end)}`;

  return queueCommand(sn, cmd);
}


function parseATTLOG(raw: string) {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);

  return lines.map((line) => {
    // ATTLOG typically fields separated by tabs or spaces
    const parts = line.trim().split(/\t+|\s+/);

    // Common format: PIN YYYY-MM-DD HH:MM:SS Status Verify WorkCode ...
    const pin = parts[0];
    const date = parts[1];
    const time = parts[2];
    const status = parts[3];
    const verify = parts[4];
    const workcode = parts[5];

    return {
      pin,
      datetime: date && time ? `${date} ${time}` : parts[1],
      status,
      verify,
      workcode,
      raw: line
    };
  });
}

// --- Command Queue State ---
// Map<SN, Array<{ id: number, cmd: string }>>
const commandQueue = new Map<string, Array<{ id: number; cmd: string }>>();
let cmdCounter = 1;

const app = new Elysia()
  .use(swagger({
    path: "/swagger",
    documentation: {
      info: {
        title: "ZK ADMS API",
        version: "1.0.0"
      }
    }
  }))
  // --- Admin API to queue commands ---
  .post("/api/cmd", async ({ body }) => {
    const { sn, command } = body as { sn: string; command: string };
    if (!sn || !command) return new Response("Missing sn or command", { status: 400 });

    if (!commandQueue.has(sn)) {
      commandQueue.set(sn, []);
    }

    const id = cmdCounter++;
    commandQueue.get(sn)!.push({ id, cmd: command });

    console.log(`\n[CMD] Queued for ${sn}: [${id}] ${command}`);
    return { status: "queued", id, command };
  })

  .get("/iclock/cdata", ({ query }) => {
    console.log("\n=== GET /iclock/cdata", new Date().toISOString(), "===");
    console.log("Query:", JSON.stringify(query, null, 2));

    const { SN, type, options } = query;

    // time request
    if (type === "time") {
      return new Response(formatDeviceTime(), { headers: { "Content-Type": "text/plain" } });
    }

    // initial handshake/options
    if (options) {
      const responseLines = [
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
        // protocol version hint; safe to include
        "PushProtVer=2.4.1"
      ];

      return new Response(responseLines.join("\n"), { headers: { "Content-Type": "text/plain" } });
    }

    // device polling for commands, heartbeat, etc.
    return new Response("OK", { headers: { "Content-Type": "text/plain" } });
  })
  .post("/api/attlog/last2days", ({ body }) => {
    const { sn } = body as { sn: string };
    if (!sn) return new Response("Missing sn", { status: 400 });

    const id = queueLastTwoDaysAttlog(sn);
    return { status: "queued", id, sn, range: "last 2 days" };
  })
  .get("/iclock/getrequest", ({ query, path }) => {
    const { SN } = query;
    console.log("\n=== GET", path, new Date().toISOString(), "===");
    console.log("Device checking for commands:", SN);

    if (SN && commandQueue.has(SN)) {
      const queue = commandQueue.get(SN)!;

      if (queue.length > 0) {
        // Many firmwares accept multiple commands separated by \n.
        // If yours accepts only one, just send queue.shift() instead.
        const cmdsToSend = queue.splice(0, queue.length);
        const payload = cmdsToSend
          .map(c => `C:${c.id}:${c.cmd}`)
          .join("\n");

        console.log(`[CMD] Sending to ${SN}:\n${payload}`);
        return new Response(payload, {
          headers: { "Content-Type": "text/plain" }
        });
      }
    }

    return new Response("OK", { headers: { "Content-Type": "text/plain" } });
  })
  .post("/iclock/devicecmd", async ({ query, request }) => {
    console.log("\n=== POST /iclock/devicecmd (Command Result) ===");
    const raw = await request.text();
    console.log("Result Body:", raw);
    // Device sends: ID=1&Return=0&CMD=DATA QUERY USERINFO
    return new Response("OK", { headers: { "Content-Type": "text/plain" } });
  })
  .get("/iclock/ping", ({ query, path }) => {
    console.log("\n=== GET", path, new Date().toISOString(), "===");
    console.log("Query:", JSON.stringify(query, null, 2));
    return new Response("OK", { headers: { "Content-Type": "text/plain" } });
  })
  .post("/iclock/cdata", async ({ query, request }) => {
    console.log("\n=== POST /iclock/cdata", new Date().toISOString(), "===");
    console.log("Query:", JSON.stringify(query, null, 2));

    const raw = await request.text();
    // console.log("Raw body:\n" + raw); // verbose

    const table = String(query.table || "").toUpperCase();

    if (table === "ATTLOG") {
      const records = parseATTLOG(raw);
      console.log("Parsed ATTLOG records:", records);
      return new Response(`OK:${records.length}`, { headers: { "Content-Type": "text/plain" } });
    }

    if (table === "USERINFO") {
      console.log("Received USERINFO:");
      console.log(raw);
      // Format: User_PIN	Name	Privilege	Password	Card	Group	TimeZones	...
      const lines = raw.trim().split(/\r?\n/);
      console.log(`Received ${lines.length} users.`);
      return new Response(`OK:${lines.length}`, { headers: { "Content-Type": "text/plain" } });
    }

    if (table === "OPERLOG") {
      console.log("OPERLOG received (user/template/system logs).");
      return new Response("OK", { headers: { "Content-Type": "text/plain" } });
    }

    if (table === "ATTPHOTO") {
      console.log("ATTPHOTO received (photo/base64).");
      return new Response("OK", { headers: { "Content-Type": "text/plain" } });
    }

    // default
    return new Response("OK", { headers: { "Content-Type": "text/plain" } });
  })
  .listen(PORT);

console.log(`\nADMS/PUSH server listening on http://0.0.0.0:${PORT}`);
