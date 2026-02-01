/**
 * Tests for the classify response parsing logic from background.js.
 * Run with: node --test test/parse-response.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Mirrors the parsing logic in classifyViaGenerate().
 */
function parseClassifyResponse(rawResponse) {
  const output = rawResponse
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim();

  const has0 = output.includes("0");
  const has1 = output.includes("1");

  if (!has0 && !has1) {
    // Fallback: infer from think block reasoning
    const thinkMatch = rawResponse.match(/<think>[\s\S]*?<\/think>/);
    if (thinkMatch) {
      const t = thinkMatch[0].toLowerCase();
      const hamPatterns = ["not spam", "not indicative of spam", "is ham",
        "is legitimate", "is not", "legitimate email"];
      const spamPatterns = ["classifying as spam", "is spam", "spam content",
        "typical of spam", "likely spam", "indicates spam"];
      const hamHits = hamPatterns.filter((p) => t.includes(p)).length;
      const spamHits = spamPatterns.filter((p) => t.includes(p)).length;
      if (spamHits > hamHits) return { spam: true, confidence: 0.7 };
      if (hamHits > spamHits) return { spam: false, confidence: 0.7 };
    }
    throw new Error(`Unexpected classify response: "${rawResponse}"`);
  }

  let isSpam;
  if (has0 && !has1) isSpam = false;
  else if (has1 && !has0) isSpam = true;
  else isSpam = output.lastIndexOf("1") > output.lastIndexOf("0");

  return { spam: isSpam, confidence: 1.0 };
}

describe("parseClassifyResponse", () => {
  describe("real model outputs from logs", () => {
    it("think says spam but output is 0 → ham", () => {
      const r = parseClassifyResponse(
        '<think>The message "PMZYZ8-9W2V" looks like an automated bot message with no human content. Classifying as spam.</think>\n\n0',
      );
      assert.equal(r.spam, false);
    });

    it("think says spam-like content but output is 0 → ham", () => {
      const r = parseClassifyResponse(
        "<think>The message appears to be a summary of a news article with links, which is typical of spam content.</think>\n\n0",
      );
      assert.equal(r.spam, false);
    });

    it("think says spam content, output is 1 → spam", () => {
      const r = parseClassifyResponse(
        "<think>The message appears to be a summary of a transaction link, which is typical of spam content.</think>\n\n1",
      );
      assert.equal(r.spam, true);
    });

    it("think says not spam, output is 1 → spam", () => {
      const r = parseClassifyResponse(
        '<think>The message "Er is een pakket naar je onderweg" translates to "There is a package sent to you on your way.". This message conveys a legitimate reminder about a package, which is not indicative of spam, so I will respond with 1.</think>\n\n1',
      );
      assert.equal(r.spam, true);
    });

    it("think mentions respond with 0, output is 0 → ham", () => {
      const r = parseClassifyResponse(
        "<think>The message appears to be a styled text message with no other content, which is likely spam, so I will respond with 0.</think>\n\n0",
      );
      assert.equal(r.spam, false);
    });
  });

  describe("plain outputs without think tags", () => {
    it("bare 0 → ham", () => {
      assert.equal(parseClassifyResponse("0").spam, false);
    });

    it("bare 1 → spam", () => {
      assert.equal(parseClassifyResponse("1").spam, true);
    });

    it("0 with whitespace → ham", () => {
      assert.equal(parseClassifyResponse("  0\n").spam, false);
    });

    it("1 with whitespace → spam", () => {
      assert.equal(parseClassifyResponse("\n1  ").spam, true);
    });
  });

  describe("think block contains digits but actual output differs", () => {
    it("think contains 1 but output is 0 → ham", () => {
      const r = parseClassifyResponse(
        "<think>I will respond with 1 because it looks suspicious.</think>\n\n0",
      );
      assert.equal(r.spam, false);
    });

    it("think contains 0 but output is 1 → spam", () => {
      const r = parseClassifyResponse(
        "<think>This is not spam so I would say 0 but actually it is.</think>\n\n1",
      );
      assert.equal(r.spam, true);
    });
  });

  describe("multiple think blocks", () => {
    it("two think blocks, output is 0 → ham", () => {
      const r = parseClassifyResponse(
        "<think>First thought.</think><think>Second thought with 1.</think>\n\n0",
      );
      assert.equal(r.spam, false);
    });
  });

  describe("stray text in output (model outputs letter instead of digit)", () => {
    it("think block + stray letter A → falls back to think reasoning (spam)", () => {
      const r = parseClassifyResponse(
        "<think>The message appears to be a summary of an article with a hashtag, which is typical of spam content.</think>\n\nA",
      );
      assert.equal(r.spam, true);
      assert.equal(r.confidence, 0.7);
    });

    it("think block + stray letter → falls back to think reasoning (not spam)", () => {
      const r = parseClassifyResponse(
        "<think>This is not spam, it is a legitimate email.</think>\n\nB",
      );
      assert.equal(r.spam, false);
      assert.equal(r.confidence, 0.7);
    });

    it("think block with 'is ham' + stray text → ham", () => {
      const r = parseClassifyResponse(
        "<think>This message is ham.</think>\n\nX",
      );
      assert.equal(r.spam, false);
      assert.equal(r.confidence, 0.7);
    });
  });

  describe("error cases", () => {
    it("throws on empty think with no reasoning keywords", () => {
      assert.throws(() =>
        parseClassifyResponse("<think>Some generic reasoning.</think>"),
      );
    });

    it("throws on no digits and no think block", () => {
      assert.throws(() => parseClassifyResponse("ham"));
    });

    it("throws on only text no digits no think", () => {
      assert.throws(() => parseClassifyResponse("this is an email"));
    });
  });
});
