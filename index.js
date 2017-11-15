'use strict'
const request = require('request-promise');
const htmlEntities = new (require('html-entities').XmlEntities)();

const JISHO_API = 'http://jisho.org/api/v1/search/words';
const SCRAPE_BASE_URI = 'http://jisho.org/search/';
const STROKE_ORDER_DIAGRAM_BASE_URL = 'http://classic.jisho.org/static/images/stroke_diagrams/';

const ONYOMI_LOCATOR_SYMBOL = 'On';
const KUNYOMI_LOCATOR_SYMBOL = 'Kun';

function superTrim(str) {
  if (!str) {
    return;
  }
  str = str.replace(/(?:\r\n|\r|\n)/g, '');
  str = str.trim();
  return str;
}

function uriForKanjiSearch(kanji) {
  return SCRAPE_BASE_URI + encodeURIComponent(kanji) + '%23kanji';
}

function uriForExampleSearch(phrase) {
  return SCRAPE_BASE_URI + encodeURIComponent(phrase) + '%23sentences';
}

function getUriForStrokeOrderDiagram(kanji) {
  return STROKE_ORDER_DIAGRAM_BASE_URL + kanji.charCodeAt(0).toString() + '_frames.png';
}

function containsKanjiGlyph(pageHtml, kanji) {
  let kanjiGlyphToken = '<h1 class=\"character\" data-area-name=\"print\" lang=\"ja\">' + kanji + '</h1>';
  return pageHtml.indexOf(kanjiGlyphToken) !== -1;
}

function getDataBetweenIndicies(data, startIndex, endIndex) {
  let result = data.substring(startIndex, endIndex);
  return superTrim(result);
}

function getStringBetweenStrings(data, startString, endString) {
  let startStringLocation = data.indexOf(startString);
  if (startStringLocation === -1) {
    return;
  }
  let startIndex = startStringLocation + startString.length;
  let endIndex = data.indexOf(endString, startIndex);
  if (endIndex >= 0) {
    return getDataBetweenIndicies(data, startIndex, endIndex);
  }
}

function getIntBetweenStrings(pageHtml, startString, endString) {
  let stringBetweenStrings = getStringBetweenStrings(pageHtml, startString, endString);
  if (stringBetweenStrings) {
    return parseInt(stringBetweenStrings);
  }
}

function parseAnchorsToArray(str) {
  const closeAnchor = '</a>';
  let rest = str;
  let results = [];

  while (rest.indexOf('<') !== -1) {
    let result = getStringBetweenStrings(rest, '>', '<');
    results.push(result);
    rest = rest.substring(rest.indexOf(closeAnchor) + closeAnchor.length);
  }

  return results;
}

function getYomi(pageHtml, yomiLocatorSymbol) {
  let yomiSection = getStringBetweenStrings(pageHtml, `<dt>${yomiLocatorSymbol}:</dt>`, '</dl>');
  if (yomiSection) {
    let yomiString = getStringBetweenStrings(yomiSection, '<dd class=\"kanji-details__main-readings-list\" lang=\"ja\">', '</dd>');
    if (yomiString) {
      let readings = parseAnchorsToArray(yomiString);
      return readings;
    }
  }
  return [];
}

function getKunyomi(pageHtml) {
  return getYomi(pageHtml, KUNYOMI_LOCATOR_SYMBOL);
}

function getOnyomi(pageHtml) {
  return getYomi(pageHtml, ONYOMI_LOCATOR_SYMBOL);
}

function getOnyomiExamples(pageHtml) {
  return getExamples(pageHtml, ONYOMI_LOCATOR_SYMBOL);
}

function getKunyomiExamples(pageHtml) {
  return getExamples(pageHtml, KUNYOMI_LOCATOR_SYMBOL);
}

function getExamples(pageHtml, yomiLocatorSymbol) {
  let locatorString = `<h2>${yomiLocatorSymbol} reading compounds</h2>`;
  let exampleSectionStartIndex = pageHtml.indexOf(locatorString);
  let exampleSectionEndIndex = pageHtml.indexOf('</ul>', exampleSectionStartIndex);
  if (exampleSectionStartIndex === -1 || exampleSectionEndIndex === -1) {
    return [];
  }

  let exampleSection = pageHtml.substring(exampleSectionStartIndex, exampleSectionEndIndex);
  exampleSection = exampleSection.replace(locatorString, '');
  exampleSection = exampleSection.replace('<ul class=\"no-bullet\">', '');
  let examplesLines = exampleSection.split('\n');

  const lengthOfExampleInLines = 5;
  const exampleOffset = 1;
  const readingOffset = 2;
  const meaningOffset = 3;

  let examples = [];
  let exampleIndex = 0;
  examplesLines = examplesLines.map(line => superTrim(line));

  while (examplesLines[0] !== '<li>') {
    examplesLines.shift(1);
  }
  while (examplesLines[examplesLines.length - 1] !== '</li>') {
    examplesLines.pop();
  }

  for (let i = 0; i < examplesLines.length; i += lengthOfExampleInLines) {
    examples[exampleIndex] = {
      example: examplesLines[i + exampleOffset],
      reading: examplesLines[i + readingOffset].replace('【', '').replace('】', ''),
      meaning: htmlEntities.decode(examplesLines[i + meaningOffset]),
    };
    ++exampleIndex;
  }

  return examples;
}

function getRadical(pageHtml) {
  const radicalMeaningStartString = '<span class="radical_meaning">';
  const radicalMeaningEndString = '</span>';
  let radicalMeaning = getStringBetweenStrings(pageHtml, radicalMeaningStartString, radicalMeaningEndString);

  if (radicalMeaning) {
    let radicalMeaningStartIndex = pageHtml.indexOf(radicalMeaningStartString);
    let radicalMeaningEndIndex = pageHtml.indexOf(radicalMeaningEndString, radicalMeaningStartIndex);
    let radicalSymbolStartIndex = radicalMeaningEndIndex + radicalMeaningEndString.length;
    const radicalSymbolEndString = '</span>';
    let radicalSymbolEndIndex = pageHtml.indexOf(radicalSymbolEndString, radicalSymbolStartIndex);
    let radicalSymbol = getDataBetweenIndicies(pageHtml, radicalSymbolStartIndex, radicalSymbolEndIndex);
    return {symbol: radicalSymbol, meaning: radicalMeaning};
  }
}

function getParts(pageHtml) {
  const partsSectionStartString = '<dt>Parts:</dt>';
  const partsSectionEndString = '</dl>';
  let partsSection = getStringBetweenStrings(pageHtml, partsSectionStartString, partsSectionEndString);
  partsSection = partsSection.replace('<dd>', '').replace('</dd>');
  return parseAnchorsToArray(partsSection);
}

function parseKanjiPageData(pageHtml, kanji) {
  let result = {};
  result.query = kanji;
  result.found = containsKanjiGlyph(pageHtml, kanji);
  if (!result.found) {
    return result;
  }

  result.gradeNumber = getIntBetweenStrings(pageHtml, 'taught in <strong>grade ', '</strong>');
  result.level = getStringBetweenStrings(pageHtml, 'taught in <strong>', '</strong>');
  result.strokeCount = getIntBetweenStrings(pageHtml, '<strong>', '</strong> strokes');
  result.meaning = superTrim(getStringBetweenStrings(pageHtml, '<div class=\"kanji-details__main-meanings\">', '</div>'));
  result.kunyomi = getKunyomi(pageHtml);
  result.onyomi = getOnyomi(pageHtml);
  result.onyomiExamples = getOnyomiExamples(pageHtml);
  result.kunyomiExamples = getKunyomiExamples(pageHtml);
  result.radical = getRadical(pageHtml);
  result.parts = getParts(pageHtml);
  result.strokeOrderDiagramUri = getUriForStrokeOrderDiagram(kanji);
  return result;
}

class API {
  searchForPhrase(phrase, timeout) {
    timeout = timeout || 10000;
    return request({
      uri: JISHO_API,
      qs: {
        keyword: phrase,
      },
      json: true,
      timeout: timeout
    });
  }

  searchForKanji(kanji, timeout) {
    timeout = timeout || 10000;
    let uri = uriForKanjiSearch(kanji);
    return request({
      uri: uri,
      json: false,
      timeout: timeout
    }).then(pageHtml => {
      return parseKanjiPageData(pageHtml, kanji);
    });
  }
}

module.exports = API;
