import {describe, expect, test} from 'vitest'

import {parseBriefing, parseDialogue} from '../src/index.ts'

describe('parseDialogue', () => {
  const sample =
    'Languages:5\r\n' +
    'Filename:\tSRWOLVES\r\n' +
    'Eng:"Wolves...better be careful"\r\n' +
    'Ita:\r\n' +
    'Fra:\r\n' +
    'Filename:       SPYOUWIL\r\n' +
    'Eng: "You will begin."\r\n' +
    'Ger: "Sie beginnen." \r\n'

  test('reads the language count and one entry per Filename', () => {
    const {languageCount, entries} = parseDialogue(sample)
    expect(languageCount).toBe(5)
    expect(entries.map((entry) => entry.filename)).toEqual(['SRWOLVES', 'SPYOUWIL'])
  })

  test('captures translations per language, unquoting and allowing empties', () => {
    const {entries} = parseDialogue(sample)
    expect(entries[0]!.translations).toEqual([
      {language: 'Eng', text: 'Wolves...better be careful'},
      {language: 'Ita', text: ''},
      {language: 'Fra', text: ''},
    ])
    expect(entries[1]!.translations).toEqual([
      {language: 'Eng', text: 'You will begin.'},
      {language: 'Ger', text: 'Sie beginnen.'},
    ])
  })

  test('accepts raw bytes', () => {
    const bytes = new TextEncoder().encode('Languages:1\r\nFilename:X\r\nEng:"hi"\r\n')
    expect(parseDialogue(bytes).entries[0]).toEqual({
      filename: 'X',
      translations: [{language: 'Eng', text: 'hi'}],
    })
  })
})

describe('parseBriefing', () => {
  const sample =
    '//Eng:----------\r\n' +
    '"April 21nd 1927"\r\n' +
    '\r\n' +
    'Mission Objectives:\r\n' +
    '1: "Defend the carrier."\r\n' +
    '//Fre:----------\r\n' +
    '"21 avril 1927"\r\n'

  test('splits into one section per //language delimiter', () => {
    const sections = parseBriefing(sample)
    expect(sections.map((section) => section.language)).toEqual(['Eng', 'Fre'])
  })

  test('keeps the section body verbatim (including colons), trimming blank edges', () => {
    const [eng, fre] = parseBriefing(sample)
    expect(eng!.text).toBe('"April 21nd 1927"\n\nMission Objectives:\n1: "Defend the carrier."')
    expect(fre!.text).toBe('"21 avril 1927"')
  })

  test('ignores any content before the first delimiter', () => {
    expect(parseBriefing('stray\r\n//Eng:--\r\nbody\r\n')).toEqual([
      {language: 'Eng', text: 'body'},
    ])
  })
})
