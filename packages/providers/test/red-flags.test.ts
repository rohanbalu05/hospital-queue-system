import { describe, expect, it } from 'vitest';
import { FakeLlmProvider, redFlagSymptom, type LlmContextItem } from '../src/index.js';

const SHOULD_FLAG: Array<[string, string]> = [
  // chest pain / pressure
  ['chest_pain', 'I have chest pain'],
  ['chest_pain', 'Chest pain since this morning, what should I do?'],
  ['chest_pain', "there's a pressure in my chest"],
  ['chest_pain', 'a tight feeling in my chest and left arm'],
  ['chest_pain', 'pain in the chest when I climb stairs'],
  ['chest_pain', 'my chest feels heavy and tight'],
  ['chest_pain', 'I think I am having a heart attack'],
  ['chest_pain', 'CHEST PAIN!!!'],
  // breathing
  ['breathing', 'I have difficulty breathing'],
  ['breathing', "I can't breathe properly"],
  ['breathing', 'cannot catch my breath after walking'],
  ['breathing', 'I am short of breath even at rest'],
  ['breathing', 'shortness of breath at night'],
  ['breathing', 'trouble breathing since last night'],
  ['breathing', 'it is hard to breathe'],
  ['breathing', 'I am struggling to breathe'],
  ['breathing', 'my breathing is difficult'],
  ['breathing', 'feeling breathless and sweaty'],
  // fainting
  ['fainting', 'I fainted this morning'],
  ['fainting', 'my father passed out in the bathroom'],
  ['fainting', 'I feel like I am going to faint'],
  ['fainting', 'she is unconscious and not responding'],
  ['fainting', 'I blacked out after standing up'],
  ['fainting', 'I feel faint after the injection'],
  // bleeding
  ['bleeding', 'severe bleeding from the wound'],
  ['bleeding', 'the bleeding will not stop'],
  ['bleeding', "bleeding won't stop after the extraction"],
  ['bleeding', 'I am bleeding heavily'],
  ['bleeding', 'heavy bleeding since yesterday'],
  ['bleeding', 'I vomited blood this morning'],
  ['bleeding', 'vomiting blood and feeling weak'],
  ['bleeding', 'I keep coughing up blood'],
  ['bleeding', 'there was blood in my vomit'],
  // swelling of face / throat
  ['swelling', 'my face is swollen'],
  ['swelling', 'swelling of my lips and tongue'],
  ['swelling', 'my tongue is swelling up'],
  ['swelling', 'swollen throat and I cannot swallow'],
  ['swelling', 'my throat feels like it is closing'],
  ['swelling', 'there is swelling around my face and eyes'],
  // stroke
  ['stroke', 'my mother has a drooping face on one side'],
  ['stroke', 'his face is drooping'],
  ['stroke', 'slurred speech since an hour'],
  ['stroke', 'her speech is slurred and she is confused'],
  ['stroke', 'sudden weakness on one side of the body'],
  ['stroke', 'my left arm feels weak and numb on one side'],
  ['stroke', 'I think I am having a stroke'],
  // seizure
  ['seizure', 'my son had a seizure'],
  ['seizure', 'I am having a seizure'],
  ['seizure', 'she is having convulsions'],
  ['seizure', 'he had a fit just now'],
  ['seizure', 'another seizure today'],
  // suicidal thoughts
  ['suicide', 'I am having suicidal thoughts'],
  ['suicide', 'I want to kill myself'],
  ['suicide', 'I want to end my life'],
  ['suicide', "I don't want to live anymore"],
  ['suicide', 'thinking about suicide'],
  ['suicide', 'I want to hurt myself'],
  // reaction after new medicine
  ['medicine_reaction', 'I feel dizzy after the new tablets. Should I stop taking them?'],
  ['medicine_reaction', 'I have a rash after starting the new medicine'],
  ['medicine_reaction', 'itching all over since I started the medicine'],
  ['medicine_reaction', 'swelling after taking the tablet'],
  ['medicine_reaction', 'dizzy after taking my new tablets'],
  ['medicine_reaction', 'after the injection I got hives'],
  ['medicine_reaction', 'since the new tablet I am very dizzy'],
];

const SHOULD_NOT_FLAG = [
  'my chest X-ray report',
  'Where do I collect my chest X-ray report?',
  'no chest pain',
  'I have no chest pain, only a cough',
  'without any chest pain or shortness of breath',
  "I don't have chest pain",
  'never had chest pain',
  'chest physiotherapy timings',
  'What time does the chest clinic open?',
  'How often should I take paracetamol?',
  'When is my next appointment?',
  'I am bleeding-edge fan of the new app', // "bleeding" alone is not severe bleeding
  'can I take the tablet after food?',
  'what is the dose after the first week',
  'I do not feel dizzy now',
  'is the rash cream to be applied after bath',
  'my seizure medicine is finished, where can I refill',
  'Can I get a seizure medication refill?',
  'Is my face wash safe to use',
  'my ankles are a little swollen in the evening',
  'I need to book a follow-up',
  'how long will the check-up take',
  'I am fit and healthy',
  'the speech therapy appointment',
  'no shortness of breath, no fainting',
  'no suicidal thoughts',
];

describe('redFlagSymptom (PR-13)', () => {
  it.each(SHOULD_FLAG)('flags %s: "%s"', (category, text) => {
    expect(redFlagSymptom(text)).toBe(category);
  });

  it.each(SHOULD_NOT_FLAG)('does not flag: "%s"', (text) => {
    expect(redFlagSymptom(text)).toBeNull();
  });

  it('handles curly apostrophes, case and extra spaces', () => {
    expect(redFlagSymptom('I   CAN’T   breathe')).toBe('breathing');
    expect(redFlagSymptom('DON’T WANT TO LIVE')).toBe('suicide');
  });

  it('a negated symptom does not hide a different, un-negated one', () => {
    expect(redFlagSymptom('no chest pain but I cannot breathe')).toBe('breathing');
    expect(redFlagSymptom('no fever, however I fainted')).toBe('fainting');
  });

  it('returns the first matching category deterministically, and null for empty text', () => {
    expect(redFlagSymptom('chest pain and I fainted')).toBe(redFlagSymptom('chest pain and I fainted'));
    expect(redFlagSymptom('')).toBeNull();
  });
});

describe('FakeLlmProvider and red flags', () => {
  const ctx: LlmContextItem = {
    instructionVersionId: '11111111-1111-4111-8111-111111111111',
    title: 'Fever medicines',
    version: 1,
    body: 'Take Tab Paracetamol 500 mg three times a day after food for 5 days.',
  };
  it('never answers a red-flag question from the instructions (unsupported, code red_flag)', async () => {
    const r = await new FakeLlmProvider().answer({ question: 'I have chest pain. How often should I take paracetamol?', context: [ctx] });
    expect(r).toMatchObject({ kind: 'unsupported', code: 'red_flag' });
  });
});
