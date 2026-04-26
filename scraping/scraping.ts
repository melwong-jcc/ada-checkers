import "dotenv/config";

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { Audit, Outcome, Question, Requirement, Rule } from "@siteimprove/alfa-act";
import { Document, Element, Query } from "@siteimprove/alfa-dom";
import { Hashable } from "@siteimprove/alfa-hash";
import { Scraper } from "@siteimprove/alfa-scraper";
import Rules, { experimentalRules } from "@siteimprove/alfa-rules";
import { Conformance, Criterion } from "@siteimprove/alfa-wcag";

type EarlAssertion = Record<string, unknown>;
type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

type SiteimproveConfig = {
  username: string;
  apiKey: string;
  baseUrl: string;
};

type SiteimproveResult = {
  contentId: string;
  issues: JsonValue;
  summary: JsonValue;
};

type ReportPaths = {
  csv: string;
  earlJson: string;
  siteimproveIssuesJson: string;
  siteimproveSummaryJson: string;
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const fixturePath = path.join(__dirname, "fixtures", "page.html");
const local = url.pathToFileURL(fixturePath).toString();
const siteimprove = getSiteimproveConfig();

const page = process.argv?.[2] ?? local;
const rules: Array<Rule<any, any, Question.Metadata, any>> = [
  ...Rules,
  ...Object.values(experimentalRules),
];

Scraper.with(async (scraper) => {
  const alfaPage = await scraper.scrape(page);

  if (alfaPage.isErr()) {
    // If the scrape failed, exit with non-0 code.
    console.error(alfaPage.getErr());

    process.exit(1);
  }

  for (const input of alfaPage) {
    const outcomes = await Audit.of(input, rules)
      .evaluate()
      .map((outcomes) => [...outcomes]);

    const filtered = outcomes.filter((outcome) => Outcome.isFailed(outcome) || Outcome.isCantTell(outcome));

    const earl = filtered.map((outcome) => outcome.toEARL());

    const { url } = input.response;
    const elementDescriptions = getElementDescriptions(input.document);
    const ruleCriteriaMap = buildRuleCriteriaMap(filtered);
    const ruleLevelMap = buildRuleLevelMap(filtered);

    console.group(url.toString());
    logWcagVersions(filtered);
    logStats(outcomes);
    console.groupEnd();

    const reportPaths = getReportPaths(url.toString());

    fs.mkdirSync(path.dirname(reportPaths.earlJson), { recursive: true });

    fs.writeFileSync(reportPaths.earlJson, JSON.stringify(earl, null, 2));
    fs.writeFileSync(
      reportPaths.csv,
      formatCsvReport(url.toString(), earl, elementDescriptions, ruleCriteriaMap, ruleLevelMap),
    );

    if (siteimprove !== null) {
      const html = await readPageHtml(url.toString());

      if (html === null) {
        console.warn(`Skipping Siteimprove upload for ${url.toString()}: unable to read HTML content.`);
      } else {
        const result = await runSiteimproveAudit(html, siteimprove);

        fs.writeFileSync(reportPaths.siteimproveSummaryJson, JSON.stringify(result.summary, null, 2));
        fs.writeFileSync(reportPaths.siteimproveIssuesJson, JSON.stringify(result.issues, null, 2));

        console.log(`Siteimprove content check: ${result.contentId}`);
      }
    }
  }
});

function getSiteimproveConfig(): SiteimproveConfig | null {
  const username = process.env.SITEIMPROVE_USERNAME?.trim() ?? "";
  const apiKey = process.env.SITEIMPROVE_API_KEY?.trim() ?? "";

  if (username === "" || apiKey === "") {
    return null;
  }

  return {
    username,
    apiKey,
    baseUrl: process.env.SITEIMPROVE_API_BASE_URL?.trim() || "https://api.siteimprove.com/v2",
  };
}

function getReportPaths(pageUrl: string): ReportPaths {
  if (pageUrl === local) {
    const fixtureBase = path.join(__dirname, "outcomes", "page.html");

    return {
      csv: `${fixtureBase}.csv`,
      earlJson: `${fixtureBase}.json`,
      siteimproveIssuesJson: `${fixtureBase}.siteimprove-issues.json`,
      siteimproveSummaryJson: `${fixtureBase}.siteimprove-summary.json`,
    };
  }

  const pageLocation = new URL(pageUrl);
  const basePath =
    path.join(
      __dirname,
      "outcomes",
      pageLocation.hostname,
      ...pageLocation.pathname.split("/").filter((segment) => segment !== ""),
    ) + "--issues";

  return {
    csv: `${basePath}.csv`,
    earlJson: `${basePath}.json`,
    siteimproveIssuesJson: `${basePath}.siteimprove.json`,
    siteimproveSummaryJson: `${basePath}.siteimprove-summary.json`,
  };
}

async function readPageHtml(pageUrl: string): Promise<string | null> {
  if (pageUrl === local) {
    return fs.readFileSync(fixturePath, "utf8");
  }

  const response = await fetch(pageUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch HTML for Siteimprove upload: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function runSiteimproveAudit(html: string, config: SiteimproveConfig): Promise<SiteimproveResult> {
  const uploadResponse = await fetch(`${config.baseUrl}/content/check`, {
    method: "POST",
    headers: {
      Authorization: getSiteimproveAuthorization(config),
      "Content-Type": "text/html; charset=utf-8",
    },
    body: html,
  });

  if (!uploadResponse.ok) {
    throw new Error(
      `Siteimprove content check upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
    );
  }

  const uploadPayload = await readJsonBody(uploadResponse);
  const contentId = getSiteimproveContentId(uploadResponse, uploadPayload);

  return {
    contentId,
    issues: await pollSiteimproveJson(`/content/checks/${contentId}/accessibility/issues`, config),
    summary: await pollSiteimproveJson(`/content/checks/${contentId}/summary`, config),
  };
}

function getSiteimproveAuthorization(config: SiteimproveConfig): string {
  return `Basic ${Buffer.from(`${config.username}:${config.apiKey}`).toString("base64")}`;
}

async function pollSiteimproveJson(pathname: string, config: SiteimproveConfig): Promise<JsonValue> {
  let lastError = "Siteimprove result was not ready.";

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${config.baseUrl}${pathname}`, {
      headers: {
        Accept: "application/json",
        Authorization: getSiteimproveAuthorization(config),
      },
    });

    if (response.ok) {
      return readJsonBody(response);
    }

    lastError = `${response.status} ${response.statusText}`;

    if (response.status !== 404 && response.status !== 409 && response.status !== 425) {
      break;
    }

    await delay(Math.min(1000 * (attempt + 1), 4000));
  }

  throw new Error(`Siteimprove result fetch failed for ${pathname}: ${lastError}`);
}

async function readJsonBody(response: Response): Promise<JsonValue> {
  const text = await response.text();

  if (text.trim() === "") {
    return {};
  }

  return JSON.parse(text) as JsonValue;
}

function getSiteimproveContentId(response: Response, payload: JsonValue): string {
  if (typeof payload === "object" && payload !== null) {
    const id = (payload as JsonObject).content_id;

    if (typeof id === "string" && id !== "") {
      return id;
    }
  }

  const location = response.headers.get("location") ?? "";
  const matches = location.match(/\/content\/checks\/([^/?#]+)/);

  if (matches?.[1]) {
    return matches[1];
  }

  throw new Error("Siteimprove content check response did not include a content_id.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatCsvReport(
  pageUrl: string,
  assertions: Array<EarlAssertion>,
  elementDescriptions: Map<string, string>,
  ruleCriteriaMap: Map<string, string>,
  ruleLevelMap: Map<string, string>,
): string {
  const header = [
    "page_url",
    "rule_id",
    "rule_url",
    "wcag_criteria",
    "conformance_level",
    "outcome",
    "message",
    "element",
  ];
  const levelOrder: Record<string, number> = { A: 0, AA: 1, AAA: 2, "BEST PRACTICE": 3 };

  const rows = assertions
    .filter((assertion) => {
      const ruleUrl = getNestedString(assertion, ["earl:test", "@id"]);

      if ((ruleCriteriaMap.get(ruleUrl) ?? "") === "") return false;
      if ((ruleLevelMap.get(ruleUrl) ?? "") === "") return false;

      const outcome = getNestedString(assertion, ["earl:result", "earl:outcome", "@id"]);
      if (stripEarlPrefix(outcome) === "cantTell") {
        const pointer = getNestedString(assertion, ["earl:result", "earl:pointer", "ptr:expression"]);
        if (!elementDescriptions.get(pointer)) return false;
      }

      return true;
    })
    .map((assertion) => {
    const ruleUrl = getNestedString(assertion, ["earl:test", "@id"]);
    const outcome = getNestedString(assertion, ["earl:result", "earl:outcome", "@id"]);
    const message = getNestedString(assertion, ["earl:result", "earl:info"]);
    const pointer = getNestedString(assertion, ["earl:result", "earl:pointer", "ptr:expression"]);

    return [
      pageUrl,
      getRuleId(ruleUrl),
      ruleUrl,
      ruleCriteriaMap.get(ruleUrl) ?? "",
      ruleLevelMap.get(ruleUrl) ?? "",
      stripEarlPrefix(outcome),
      message,
      elementDescriptions.get(pointer) ?? elementDescriptions.get(pointer.replace(/\/text\(\)\[\d+\]$/, "")) ?? "",
    ];
  }).sort((a, b) => (levelOrder[a[4]] ?? 99) - (levelOrder[b[4]] ?? 99));

  return [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n") + "\n";
}

function buildRuleCriteriaMap<I, T extends Hashable, Q extends Question.Metadata>(
  outcomes: Array<Outcome<I, T, Q>>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const outcome of outcomes) {
    const uri = outcome.rule.uri;

    if (!map.has(uri)) {
      const criteria = outcome.rule.requirements
        .filter((req): req is Criterion => req instanceof Criterion)
        .map((criterion) => criterion.chapter)
        .join(", ");

      map.set(uri, criteria);
    }
  }

  return map;
}

function buildRuleLevelMap<I, T extends Hashable, Q extends Question.Metadata>(
  outcomes: Array<Outcome<I, T, Q>>,
): Map<string, string> {
  const isA = Conformance.isA();
  const isAA = Conformance.isAA();
  const isAAA = Conformance.isAAA();

  const map = new Map<string, string>();

  for (const outcome of outcomes) {
    const uri = outcome.rule.uri;

    if (!map.has(uri)) {
      const levels = outcome.rule.requirements
        .filter((req): req is Criterion => req instanceof Criterion)
        .map((criterion) => {
          if (isA(criterion)) return "A";
          if (isAA(criterion)) return "AA";
          if (isAAA(criterion)) return "AAA";
          return "";
        })
        .filter((lvl) => lvl !== "");

      const level = levels.includes("A")
        ? "A"
        : levels.includes("AA")
          ? "AA"
          : levels.includes("AAA")
            ? "AAA"
            : "";

      map.set(uri, level);
    }
  }

  return map;
}

function logWcagVersions<I, T extends Hashable, Q extends Question.Metadata>(
  outcomes: Array<Outcome<I, T, Q>>,
): void {
  const versions = new Set<string>();

  for (const outcome of outcomes) {
    for (const requirement of outcome.rule.requirements) {
      if (!(requirement instanceof Criterion)) {
        continue;
      }

      for (const version of requirement.versions) {
        versions.add(version);
      }
    }
  }

  console.log(
    `WCAG versions: ${versions.size === 0 ? "none" : [...versions].sort().map((version) => `WCAG ${version}`).join(", ")}`,
  );
}

function getElementDescriptions(document: Document): Map<string, string> {
  const descriptions = new Map<string, string>();

  for (const element of Query.getElementDescendants(document)) {
    descriptions.set(element.path(), describeElement(element));
  }

  return descriptions;
}

function describeElement(element: Element): string {
  const id = element.id.getOr("");
  const classes = Array.from(element.classes).slice(0, 3);
  const selector = [
    element.name,
    id === "" ? "" : `#${id}`,
    classes.length === 0 ? "" : `.${classes.join(".")}`,
  ].join("");
  const text = truncate(normalizeWhitespace(element.textContent()), 80);
  const ariaLabel = truncate(getAttributeValue(element, "aria-label"), 80);
  const href = truncate(getAttributeValue(element, "href"), 80);
  const parts = [`<${selector}>`];

  if (text !== "") {
    parts.push(`text=${text}`);
  } else if (ariaLabel !== "") {
    parts.push(`aria-label=${ariaLabel}`);
  }

  if (href !== "") {
    parts.push(`href=${href}`);
  }

  return parts.join(" ");
}

function getAttributeValue(element: Element, name: string): string {
  return element.attribute(name).map((attribute) => attribute.value).getOr("");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function getNestedString(value: EarlAssertion, path: Array<string>): string {
  let current: unknown = value;

  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      return "";
    }

    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" ? current : "";
}

function getRuleId(ruleUrl: string): string {
  const segments = ruleUrl.split("/").filter((segment) => segment !== "");

  return segments.at(-1) ?? ruleUrl;
}

function stripEarlPrefix(value: string): string {
  return value.replace(/^earl:/, "");
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return `"${normalized.replace(/"/g, '""')}"`;
}

function logStats<I, T extends Hashable, Q extends Question.Metadata>(
  outcomes: Array<Outcome<I, T, Q>>,
): void {
  console.log(outcomes.filter(Outcome.isPassed).length, "passed outcomes");
  console.log(outcomes.filter(Outcome.isFailed).length, "failed outcomes");
  console.log(outcomes.filter(Outcome.isCantTell).length, "cannot tell outcomes");
  console.log(outcomes.filter(Outcome.isInapplicable).length, "inapplicable rules");
}
