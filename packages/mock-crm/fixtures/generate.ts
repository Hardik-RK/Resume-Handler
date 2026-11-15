/**
 * Synthetic résumé generator. Everything it produces is fictional: made-up names, addresses at example.com and phone
 * numbers in the UK drama range (+44 7700 900000 to 900999, reserved by the regulator for fiction).
 *
 * A batch holds text PDFs, a few scanned-style image PDFs (no text layer, so a reader must use vision), duplicate
 * people (same person, different file) and one corrupt file. `manifest` is the ground truth for tests.
 */
import { zipSync } from "fflate";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type CampaignKind = "backend" | "teacher" | "sales";
export type FileKind = "text" | "scanned" | "duplicate" | "corrupt";

export interface FakeCandidate {
  name: string;
  email: string;
  phone: string;
  city: string;
  role: string;
  education: string;
  skills: string;
  achievement: string;
  years: number;
}

export interface FixtureFile {
  name: string;
  kind: FileKind;
  bytes: Uint8Array;
  /** The person the file is about. Absent for the corrupt file. */
  candidate?: FakeCandidate;
}

export interface BatchOptions {
  /** Number of distinct fake candidates, 5 to 50. Default 12. */
  count?: number;
  seed?: number;
  campaign?: CampaignKind;
  /** Candidates rendered as image-only PDFs. Default: about one in six, at least one when count >= 6. */
  scanned?: number;
  /** Extra files that repeat an earlier person under a new file name. Default 2. */
  duplicates?: number;
  /** Add one corrupt file. Default true. */
  corrupt?: boolean;
}

export interface Batch {
  seed: number;
  campaign: CampaignKind;
  files: FixtureFile[];
  candidates: FakeCandidate[];
  manifest: Array<{ file: string; kind: FileKind; name?: string; email?: string; phone?: string }>;
}

const FIRST = ["Alina", "Bram", "Carys", "Dmitri", "Elio", "Farida", "Gustav", "Hana", "Ivo", "Jun", "Kalani", "Leona", "Mateo", "Nadia", "Oskar",
  "Petra", "Quentin", "Rosalind", "Soren", "Talia", "Umar", "Vera", "Wren", "Ximena", "Yusuf", "Zelda", "Anders", "Bianca", "Callum", "Delphine",
  "Emeka", "Freya", "Gideon", "Helga", "Idris", "Jovana", "Kenji", "Lucia", "Magnus", "Noor", "Orla", "Pavel", "Rhiannon", "Stellan", "Tamsin",
  "Ulrich", "Valentina", "Wiktor", "Yara", "Zane"];
const LAST = ["Alder", "Brightwater", "Castellan", "Dunmore", "Eastwick", "Fairbairn", "Galloway", "Hartwell", "Ironside", "Jessop", "Kestrel",
  "Lindqvist", "Marlowe", "Northcott", "Oakhurst", "Pemberton", "Quillfeather", "Ravenscroft", "Stonebridge", "Thornbury", "Underhill", "Vandermeer",
  "Whitlock", "Yarrow", "Zimmerman", "Ashdown", "Blackwood", "Cranleigh", "Delacroix", "Everhart", "Fenwick", "Greywell", "Holloway", "Ingleby",
  "Kingsley", "Lockhart", "Moorcroft", "Nightingale", "Ormerod", "Prestwick", "Rosewarne", "Sutcliffe", "Tennyson", "Upton", "Wyndham", "Abernathy",
  "Birchall", "Coldwell", "Dalrymple", "Elmstead"];
const CITIES = ["Leeds", "Bristol", "Glasgow", "Cardiff", "Norwich", "Exeter", "Belfast", "Sheffield", "York", "Brighton", "Aberdeen", "Cambridge"];

interface Template { role: string; education: string; skills: string; achievement: string }
const TEMPLATES: Record<CampaignKind, Template[]> = {
  backend: [
    { role: "Backend Engineer", education: "BSc Computer Science", skills: "Python, Django, PostgreSQL, Redis, Docker", achievement: "Cut checkout API latency by 35% across 1.5M daily requests." },
    { role: "Platform Engineer", education: "BEng Software Engineering", skills: "AWS, Terraform, Kubernetes, GitHub Actions, Linux", achievement: "Moved 25 services to containers and trimmed cloud spend by 22%." },
    { role: "Java Developer", education: "BSc Information Systems", skills: "Java, Spring Boot, Kafka, MySQL, microservices", achievement: "Built an event pipeline processing 4M messages a day." },
    { role: "Data Engineer", education: "MSc Data Science", skills: "Python, Spark, Airflow, BigQuery, dbt", achievement: "Rebuilt the nightly pipeline: runtime down from 5 hours to 50 minutes." },
    { role: "QA Automation Engineer", education: "BSc Computing", skills: "Playwright, Selenium, Java, API testing, Jenkins", achievement: "Automated 500 regression checks; release testing fell from 3 days to 5 hours." },
  ],
  teacher: [
    { role: "Physics Teacher", education: "MSc Physics, PGCE", skills: "Key stage 4-5 physics, lesson planning, online teaching, assessment", achievement: "Raised a class of 40 from 62% to 81% average in two terms." },
    { role: "Mathematics Teacher", education: "MSc Mathematics, PGCE", skills: "Algebra, calculus, exam preparation, online whiteboard teaching", achievement: "Coached 120 students; 14 gained places on competitive degree courses." },
    { role: "English Teacher", education: "MA English, PGCE", skills: "Grammar, essay writing, spoken English, exam practice", achievement: "Ran spoken-English cohorts of 60 learners with 90% completion." },
    { role: "Chemistry Teacher", education: "MSc Chemistry, PGCE", skills: "Organic chemistry, practical demonstrations, revision programmes", achievement: "Built a question bank of 2,000 problems used across three schools." },
    { role: "Computing Teacher", education: "MSc Computing, PGCE", skills: "Python for school, Scratch, web basics, project-based learning", achievement: "Designed a 20-week coding course taken by 300 pupils." },
  ],
  sales: [
    { role: "Business Development Executive", education: "BA Business Studies", skills: "Lead generation, CRM, negotiation, cold outreach, Excel", achievement: "Closed 38 new accounts in a year, 120% of target." },
    { role: "Inside Sales Associate", education: "BA Marketing", skills: "Telecalling, objection handling, follow-ups, pipeline reporting", achievement: "Held a 24% demo-to-close rate across 600 qualified leads." },
    { role: "Account Manager", education: "BSc Management", skills: "Key accounts, renewals, upselling, reporting", achievement: "Grew a 40-account book by 31% through renewals and upsell." },
    { role: "Pre-sales Consultant", education: "BSc Computer Science", skills: "Solution demos, tenders, discovery calls, SaaS products", achievement: "Supported 25 enterprise deals worth 4 million combined." },
    { role: "Customer Success Manager", education: "MBA Operations", skills: "Onboarding, churn analysis, quarterly reviews, support escalations", achievement: "Lifted retention from 82% to 91% in nine months." },
  ],
};

/** Small deterministic generator so a seed always gives the same people. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export function makeCandidates(count: number, seed: number, campaign: CampaignKind): FakeCandidate[] {
  if (!Number.isInteger(count) || count < 1 || count > FIRST.length * LAST.length) throw new RangeError("count out of range");
  const rng = makeRng(seed);
  const pairs = shuffle(FIRST.flatMap((f) => LAST.map((l) => [f, l] as const)), rng).slice(0, count);
  const templates = TEMPLATES[campaign];
  const phones = shuffle(Array.from({ length: 1000 }, (_, i) => i), rng);
  return pairs.map(([first, last], i) => {
    const template = templates[i % templates.length] as Template;
    const suffix = 900000 + (phones[i] as number);
    return {
      name: `${first} ${last}`,
      email: `${first}.${last}@example.com`.toLowerCase(),
      phone: `+44 7700 ${suffix}`,
      city: CITIES[Math.floor(rng() * CITIES.length)] as string,
      role: template.role,
      education: `${template.education}, ${2012 + Math.floor(rng() * 12)}`,
      skills: template.skills,
      achievement: template.achievement,
      years: 1 + Math.floor(rng() * 9),
    };
  });
}

function resumeLines(c: FakeCandidate): Array<{ text: string; size: number; bold?: boolean }> {
  return [
    { text: c.name, size: 20, bold: true },
    { text: `${c.email}  |  ${c.phone}  |  ${c.city}, UK`, size: 11 },
    { text: "", size: 11 },
    { text: "PROFESSIONAL SUMMARY", size: 12, bold: true },
    { text: `${c.role} with ${c.years} years of experience. Reliable, detail-oriented and comfortable with cross-functional work.`, size: 11 },
    { text: "", size: 11 },
    { text: "EDUCATION", size: 12, bold: true },
    { text: c.education, size: 11 },
    { text: "", size: 11 },
    { text: "SKILLS", size: 12, bold: true },
    { text: c.skills, size: 11 },
    { text: "", size: 11 },
    { text: "EXPERIENCE", size: 12, bold: true },
    { text: c.achievement, size: 11 },
    { text: "Worked with product, customer and operations teams; wrote documentation and mentored new joiners.", size: 11 },
  ];
}

export async function textPdf(c: FakeCandidate): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${c.name} resume`);
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  let y = 770;
  for (const line of resumeLines(c)) {
    if (line.text) page.drawText(line.text, { x: 56, y, size: line.size, font: line.bold ? bold : regular, color: rgb(0.1, 0.1, 0.1), maxWidth: 480, lineHeight: line.size + 3 });
    y -= line.size + 10 + (line.text.length > 95 ? line.size + 3 : 0);
  }
  return doc.save({ useObjectStreams: false });
}

/** A page photographed or scanned: the text exists only as pixels, slightly rotated, with speckle noise. */
export async function scannedPdf(c: FakeCandidate, rng: () => number = makeRng(7)): Promise<Uint8Array> {
  const width = 1240;
  const height = 1754;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f7f6f2";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(((rng() - 0.5) * 1.2 * Math.PI) / 180);
  ctx.translate(-width / 2, -height / 2);
  ctx.fillStyle = "#1c1c1c";
  ctx.textBaseline = "top";
  let y = 150;
  for (const line of resumeLines(c)) {
    const px = Math.round(line.size * 2.6);
    ctx.font = `${line.bold ? "bold " : ""}${px}px sans-serif`;
    if (line.text) {
      // wrap to the page width
      const words = line.text.split(" ");
      let current = "";
      for (const word of words) {
        const trial = current ? `${current} ${word}` : word;
        if (ctx.measureText(trial).width > width - 240 && current) {
          ctx.fillText(current, 120, y);
          y += px + 8;
          current = word;
        } else current = trial;
      }
      ctx.fillText(current, 120, y);
    }
    y += px + 26;
  }
  ctx.restore();
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = `rgba(60,60,60,${(rng() * 0.18).toFixed(3)})`;
    ctx.fillRect(rng() * width, rng() * height, 1 + rng() * 2, 1 + rng() * 2);
  }
  const png = canvas.toBuffer("image/png");
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const image = await doc.embedPng(png);
  const page = doc.addPage([595, 842]);
  page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  return doc.save({ useObjectStreams: false });
}

/** Looks like a PDF for a few bytes, then stops: unreadable by any parser. */
export function corruptPdf(rng: () => number): Uint8Array {
  const head = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const junk = Buffer.alloc(300);
  for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(rng() * 256);
  return new Uint8Array(Buffer.concat([head, junk]));
}

export function fileNameFor(c: FakeCandidate, suffix = "Resume"): string {
  return `${c.name.replace(/ /g, "_")}_${suffix}.pdf`;
}

export async function generateBatch(options: BatchOptions = {}): Promise<Batch> {
  const count = options.count ?? 12;
  if (!Number.isInteger(count) || count < 5 || count > 50) throw new RangeError("count must be a whole number from 5 to 50");
  const seed = options.seed ?? 2026;
  const campaign = options.campaign ?? "backend";
  const rng = makeRng(seed ^ 0x5eed);
  const candidates = makeCandidates(count, seed, campaign);
  const scannedCount = Math.min(count - 1, options.scanned ?? (count >= 6 ? Math.max(1, Math.round(count / 6)) : 0));
  const duplicateCount = Math.min(count, options.duplicates ?? 2);

  const files: FixtureFile[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] as FakeCandidate;
    const scanned = i >= candidates.length - scannedCount;
    files.push({
      name: fileNameFor(c, scanned ? "Scan" : "Resume"),
      kind: scanned ? "scanned" : "text",
      bytes: scanned ? await scannedPdf(c, rng) : await textPdf(c),
      candidate: c,
    });
  }
  // Duplicates: the same person's file again under a different name (byte-identical copy for the first, a re-saved variant for the rest).
  for (let d = 0; d < duplicateCount; d++) {
    const source = files[d] as FixtureFile;
    const c = source.candidate as FakeCandidate;
    const bytes = d % 2 === 0 ? source.bytes : await textPdf(c);
    files.push({ name: fileNameFor(c, `CV_copy${d + 1}`), kind: "duplicate", bytes, candidate: c });
  }
  if (options.corrupt ?? true) files.push({ name: "damaged_upload.pdf", kind: "corrupt", bytes: corruptPdf(rng) });

  const manifest = files.map((f) => ({
    file: f.name,
    kind: f.kind,
    ...(f.candidate ? { name: f.candidate.name, email: f.candidate.email, phone: f.candidate.phone } : {}),
  }));
  return { seed, campaign, files, candidates, manifest };
}

export function zipBatch(batch: Batch): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of batch.files) entries[f.name] = f.bytes;
  return zipSync(entries, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}
