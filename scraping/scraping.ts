import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { Audit, Outcome, Question, Requirement, Rule } from "@siteimprove/alfa-act";
import { Document, Element, Query } from "@siteimprove/alfa-dom";
import { Hashable } from "@siteimprove/alfa-hash";
import { Scraper } from "@siteimprove/alfa-scraper";
import allRules from "@siteimprove/alfa-rules";
import { Conformance, Criterion } from "@siteimprove/alfa-wcag";

type EarlAssertion = Record<string, unknown>;

const __dirname = import.meta.dirname;

const input = path.join(__dirname, "fixtures", "page.html");
const output = path.join(__dirname, "outcomes", "page.html.json");
const local = url.pathToFileURL(input).toString();

const page = process.argv?.[2] ?? local;
const rules = [...allRules];

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

    // const earl = outcomes.map((outcome) => outcome.toEARL());
    const filtered = outcomes.filter(
      (outcome) => Outcome.isFailed(outcome) || Outcome.isInapplicable(outcome),
    );

    const earl = filtered.map((outcome) => outcome.toEARL());

    const { url } = input.response;
    const elementDescriptions = getElementDescriptions(input.document);
    const ruleCriteriaMap = buildRuleCriteriaMap(filtered);

    console.group(url.toString());
    logStats(outcomes);
    console.groupEnd();

    const file =
      url.toString() === local
        ? output
        : path.join(
            __dirname,
            "outcomes",
            url.host.getOr(""),
            ...url.path.filter((segment) => segment !== ""),
          ) + "--issues.json";
    const csvFile = file.replace(/\.json$/, ".csv");

    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(file, JSON.stringify(earl, null, 2));
    fs.writeFileSync(
      csvFile,
      formatCsvReport(url.toString(), earl, elementDescriptions, ruleCriteriaMap),
    );
  }
});

function formatCsvReport(
  pageUrl: string,
  assertions: Array<EarlAssertion>,
  elementDescriptions: Map<string, string>,
  ruleCriteriaMap: Map<string, string>,
): string {
  const header = [
    "page_url",
    "rule_id",
    "rule_url",
    "wcag_criteria",
    "outcome",
    "message",
    "element",
  ];
  const rows = assertions.map((assertion) => {
    const ruleUrl = getNestedString(assertion, ["earl:test", "@id"]);
    const outcome = getNestedString(assertion, ["earl:result", "earl:outcome", "@id"]);
    const message = getNestedString(assertion, ["earl:result", "earl:info"]);
    const pointer = getNestedString(assertion, ["earl:result", "earl:pointer", "ptr:expression"]);

    return [
      pageUrl,
      getRuleId(ruleUrl),
      ruleUrl,
      ruleCriteriaMap.get(ruleUrl) ?? "",
      stripEarlPrefix(outcome),
      message,
      elementDescriptions.get(pointer) ?? "",
    ];
  });

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
  return `"${value.replace(/"/g, '""')}"`;
}

function logStats<I, T extends Hashable, Q extends Question.Metadata>(
  outcomes: Array<Outcome<I, T, Q>>,
): void {
  console.log(outcomes.filter(Outcome.isPassed).length, "passed outcomes");

  console.log(outcomes.filter(Outcome.isFailed).length, "failed outcomes");

  console.log(
    outcomes.filter(Outcome.isInapplicable).length,
    "inapplicable rules",
  );
}
