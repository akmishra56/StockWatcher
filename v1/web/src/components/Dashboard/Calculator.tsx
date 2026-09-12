import { useState } from 'react';

/**
 * Tokenizer + recursive-descent parser for +, -, *, /, (), decimals and a
 * postfix % (divides the preceding value by 100 -- the common calculator
 * convention, e.g. "200+10%" reads as 200 + 0.1). Deliberately not `eval`/
 * `new Function` even though the input here is calculator-button-driven,
 * since drag-and-drop payloads are still untrusted-origin strings.
 */
function evaluateExpression(expr: string): number {
  const tokens = tokenize(expr);
  let pos = 0;

  function peek() {
    return tokens[pos];
  }
  function next() {
    return tokens[pos++];
  }

  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const rhs = parseFactor();
      if (op === '/' && rhs === 0) throw new Error('Division by zero');
      value = op === '*' ? value * rhs : value / rhs;
    }
    return value;
  }

  function parseFactor(): number {
    let value = parsePrimary();
    while (peek() === '%') {
      next();
      value = value / 100;
    }
    return value;
  }

  function parsePrimary(): number {
    if (peek() === '-') {
      next();
      return -parsePrimary();
    }
    if (peek() === '(') {
      next();
      const value = parseExpr();
      if (next() !== ')') throw new Error('Mismatched parentheses');
      return value;
    }
    const tok = next();
    const n = Number(tok);
    if (tok === undefined || Number.isNaN(n)) throw new Error(`Unexpected token: ${tok}`);
    return n;
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error('Unexpected trailing input');
  return result;
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  const re = /\d+\.?\d*|\.\d+|[+\-*/()%]/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = re.exec(expr))) {
    if (match.index !== lastIndex) {
      const gap = expr.slice(lastIndex, match.index).trim();
      if (gap) throw new Error(`Unexpected character near "${gap}"`);
    }
    tokens.push(match[0]);
    lastIndex = re.lastIndex;
  }
  if (lastIndex !== expr.trim().length && expr.trim().length > 0) {
    const gap = expr.slice(lastIndex).trim();
    if (gap) throw new Error(`Unexpected character near "${gap}"`);
  }
  return tokens;
}

const BUTTONS: { label: string; kind: 'digit' | 'op' | 'action' }[][] = [
  [{ label: '(', kind: 'op' }, { label: ')', kind: 'op' }, { label: '%', kind: 'op' }, { label: 'C', kind: 'action' }],
  [{ label: '7', kind: 'digit' }, { label: '8', kind: 'digit' }, { label: '9', kind: 'digit' }, { label: '/', kind: 'op' }],
  [{ label: '4', kind: 'digit' }, { label: '5', kind: 'digit' }, { label: '6', kind: 'digit' }, { label: '*', kind: 'op' }],
  [{ label: '1', kind: 'digit' }, { label: '2', kind: 'digit' }, { label: '3', kind: 'digit' }, { label: '-', kind: 'op' }],
  [{ label: '0', kind: 'digit' }, { label: '.', kind: 'digit' }, { label: '=', kind: 'action' }, { label: '+', kind: 'op' }],
];

export function Calculator() {
  const [expr, setExpr] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function press(label: string) {
    if (label === 'C') {
      setExpr('');
      setResult(null);
      return;
    }
    if (label === '=') {
      try {
        const value = evaluateExpression(expr);
        setResult(formatResult(value));
      } catch {
        setResult('Error');
      }
      return;
    }
    setResult(null);
    setExpr((e) => e + label);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const value = e.dataTransfer.getData('text/plain');
    if (value && !Number.isNaN(Number(value))) {
      setResult(null);
      setExpr((prevExpr) => prevExpr + value);
    }
  }

  return (
    <div className="calculator">
      <div
        className={`calc-display ${dragOver ? 'calc-display-dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="calc-expr">{expr || 'drag a number here, or type'}</div>
        <div className="calc-result">{result ?? (expr ? '' : '0')}</div>
      </div>
      <div className="calc-grid">
        {BUTTONS.flat().map((btn) => (
          <button
            key={btn.label}
            className={`calc-btn calc-btn-${btn.kind}`}
            onClick={() => press(btn.label)}
          >
            {btn.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function formatResult(n: number): string {
  if (!Number.isFinite(n)) return 'Error';
  return Number(n.toFixed(6)).toString();
}
