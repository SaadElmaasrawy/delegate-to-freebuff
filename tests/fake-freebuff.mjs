// Stand-in for freebuff in tests. Prints a banner, waits for a submitted line containing
// "Read .briefs/<id>.md", writes .briefs/<id>.done.md (echoing what it saw), then idles until killed.
//   FAKE_FB_MODE=silent  never writes the done report and prints nothing more (to test stall handling)
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const i = process.argv.indexOf("--cwd");
const repo = i > 0 ? process.argv[i + 1] : process.cwd();

process.stdout.write("fake freebuff ready\r\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  const m = buf.match(/Read \.briefs\/(\S+?)\.md/);
  if (m && /[\r\n]/.test(buf) && process.env.FAKE_FB_MODE !== "silent") {
    writeFileSync(join(repo, ".briefs", `${m[1]}.done.md`), `status: done\n- fake freebuff saw: ${m[0]}\n`);
    process.stdout.write("wrote done report\r\n");
    buf = "";
  }
});
setInterval(() => {}, 1e6);
