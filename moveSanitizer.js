// ---------- TWO-MOVE SANITIZER WITH STAMINA + FINISHERS ----------

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function splitSentences(text) {
  return text.split(/([.!?])/).reduce((acc, part, idx, arr) => {
    if (idx % 2 === 0) {
      const sentence = part.trim();
      const punct = arr[idx + 1] || '';
      if (sentence) acc.push(sentence + punct);
    }
    return acc;
  }, []);
}

// Wrestling action verbs
const ACTION_VERBS = [
  'grab','lift','throw','slam','punch','kick','rush','swing',
  'charge','hook','whip','pull','wrench','twist','drive',
  'clothesline','tackle','suplex','drop','smash','shove','strike'
];

// Finisher keywords (Jax Nova specific or general)
const FINISHERS = [
  'nova breaker',
  'nova crash',
  'nova driver',
  'supernova slam',
  'finisher',
  'signature move',
  'final move',
  'ultimate move'
];

function isMoveSentence(sentence) {
  const lower = sentence.toLowerCase();
  return ACTION_VERBS.some(v => lower.includes(v));
}

function isFinisherSentence(sentence) {
  const lower = sentence.toLowerCase();
  return FINISHERS.some(v => lower.includes(v));
}

function keepMovesWithStamina(text, stamina) {
  const sentences = splitSentences(text);
  let moveCount = 0;
  const result = [];

  const maxMoves = stamina < 40 ? 1 : 2; // stamina suppression rule

  for (const sentence of sentences) {
    const isMove = isMoveSentence(sentence);
    const isFinisher = isFinisherSentence(sentence);

    // Finisher overrides stamina suppression
    if (isFinisher) {
      result.push(sentence);
      break;
    }

    if (isMove) {
      moveCount++;
      result.push(sentence);

      if (moveCount >= maxMoves) break;
    } else {
      result.push(sentence); // keep reaction/context
    }
  }

  return result.join(' ').trim();
}

function cleanEnding(text) {
  const trimmed = text.trim();
  const lastPunct = Math.max(
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf('!'),
    trimmed.lastIndexOf('?')
  );

  if (lastPunct === -1) return trimmed + '…';
  return trimmed.slice(0, lastPunct + 1);
}

function appendYourTurn(text) {
  const base = text.trim();
  if (base.toLowerCase().endsWith('your turn.')) return base;
  return base + ' your turn.';
}

function sanitizeMoveOutput(raw, stamina) {
  let text = normalize(raw);
  text = keepMovesWithStamina(text, stamina);
  text = cleanEnding(text);
  text = appendYourTurn(text);
  return text;
}

module.exports = { sanitizeMoveOutput };
