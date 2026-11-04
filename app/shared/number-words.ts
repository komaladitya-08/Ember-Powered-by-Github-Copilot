/**
 * Number words, which a correction may never swap ("fifteen" for "fifty" changes what is asked): zero to nineteen, the
 * tens (also written with a hyphen: "twenty-five"), hundred, thousand, million, billion, the ordinals, half, double,
 * dozen, and "a" or "an" as a quantity.
 */
export const NUMBER_WORD = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|double|twice|a|an|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|thousandth)$/;

/** Whether `word` is, or is written with, a number: digits, or a number word (also "twenty-five", word by word). */
export const isNumberWord = (word: string): boolean => /\d/.test(word) || word.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).some(w => NUMBER_WORD.test(w));

