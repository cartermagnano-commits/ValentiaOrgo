const SUBSCRIPT = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄',
  5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  a: 'ₐ', e: 'ₑ', i: 'ᵢ', j: 'ⱼ', n: 'ₙ', o: 'ₒ',
  r: 'ᵣ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
}

const SUPERSCRIPT = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴',
  5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻',
}

function mappedCharacters(value, mapping) {
  return [...value].map(character => mapping[character] ?? character).join('')
}

function replaceCommonCommands(value) {
  return value
    .replace(/\\+(?:longrightarrow|rightarrow|to)\b/g, '→')
    .replace(/\\+(?:leftrightarrow|rightleftharpoons)\b/g, '⇌')
    .replace(/\\+Delta\b/g, 'Δ')
    .replace(/\\+pi\b/g, 'π')
    .replace(/\\+sigma\b/g, 'σ')
    .replace(/\\+cdot\b/g, '·')
    .replace(/\\+pm\b/g, '±')
    .replace(/\\+(?:circ|degree)\b/g, '°')
}

function cleanMathExpression(expression) {
  let value = expression
    .replace(/\\+overset\s*\{([^{}]*)\}\s*\{\\+(?:longrightarrow|rightarrow|to)\}/g,
      (_, label) => `→ (${cleanMathExpression(label)})`)
    .replace(/\\+xrightarrow\s*\{([^{}]*)\}/g,
      (_, label) => `→ (${cleanMathExpression(label)})`)
    .replace(/\\+frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      (_, numerator, denominator) => `${cleanMathExpression(numerator)}/${cleanMathExpression(denominator)}`)
  value = replaceCommonCommands(value)
    .replace(/\\+(?:quad|qquad)\b/g, ' ')
    .replace(/\\+[,;!]/g, ' ')

  // Unwrap the small set of LaTeX containers chemistry models commonly use.
  // Repeating handles simple nesting such as \mathrm{\ce{HNO3}}.
  for (let pass = 0; pass < 4; pass += 1) {
    value = value.replace(/\\+(?:ce|mathrm|text|operatorname|textit|mathbf)\s*\{([^{}]*)\}/g, '$1')
  }

  value = value
    .replace(/_\{([0-9]+)\}|_([0-9]+)/g, (_, braced, plain) => (
      mappedCharacters(braced ?? plain, SUBSCRIPT)
    ))
    .replace(/_\{?([A-Za-z])\}?/g, (_, letter) => (
      SUBSCRIPT[letter.toLowerCase()] ?? letter
    ))
    .replace(/\^\{([0-9+\-]+)\}|\^([0-9+\-]+)/g, (_, braced, plain) => (
      mappedCharacters(braced ?? plain, SUPERSCRIPT)
    ))
    // Within a math/chemistry expression, ordinary formula digits are also
    // subscripts (H2SO4 -> H₂SO₄), even if the model omitted underscores.
    .replace(/([A-Za-z)])([0-9]+)/g, (_, atom, digits) => (
      atom + mappedCharacters(digits, SUBSCRIPT)
    ))
    .replace(/([A-Za-z₀-₉)])([+\-])(?=\s|$)/g, (_, atom, charge) => (
      atom + mappedCharacters(charge, SUPERSCRIPT)
    ))
    .replace(/\^?°/g, '°')
    .replace(/\s*<=>\s*/g, ' ⇌ ')
    .replace(/\s*(?:-{1,2}>|=>)\s*/g, ' → ')
    .replace(/[{}]/g, '')
    .replace(/\\+([A-Za-z]+)/g, '$1')
    .replace(/\\+/g, '')

  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/(\d)°\s*([CFK])\b/g, '$1 °$2')
    .trim()
}

/**
 * Converts model-emitted LaTeX/MathJax into readable plain Unicode before the
 * focused Markdown renderer runs. Backtick-delimited code is protected so a
 * valid SMILES stereochemistry slash or backslash remains exactly as written.
 */
export function normalizeAssistantFormatting(content) {
  const protectedCode = []
  let value = String(content ?? '').replace(/`[^`\n]*`/g, token => {
    const index = protectedCode.push(token) - 1
    return `\uE000${index}\uE001`
  })

  value = value
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, expression) => cleanMathExpression(expression))
    .replace(/\$([^$\n]+)\$/g, (_, expression) => cleanMathExpression(expression))
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression) => cleanMathExpression(expression))
    .replace(/\\\((.*?)\\\)/g, (_, expression) => cleanMathExpression(expression))

  // Also clean recognizable fragments when the model emitted malformed or
  // unmatched delimiters. This is deliberately narrow to avoid changing prose.
  for (let pass = 0; pass < 4; pass += 1) {
    value = value.replace(/\\+(?:ce|mathrm|text|operatorname|textit|mathbf)\s*\{([^{}]*)\}/g,
      (_, expression) => cleanMathExpression(expression))
  }
  value = replaceCommonCommands(value)
    .replace(/_\{([0-9]+)\}|_([0-9]+)/g, (_, braced, plain) => (
      mappedCharacters(braced ?? plain, SUBSCRIPT)
    ))
    .replace(/_\{?([A-Za-z])\}?/g, (_, letter) => (
      SUBSCRIPT[letter.toLowerCase()] ?? letter
    ))
    .replace(/\^\{([0-9+\-]+)\}|\^([0-9+\-]+)/g, (_, braced, plain) => (
      mappedCharacters(braced ?? plain, SUPERSCRIPT)
    ))
    .replace(/\\+\$/g, '')
    .replace(/\$/g, '')
    .replace(/\\+([\[\](){}])/g, '$1')
    .replace(/\\+([A-Za-z]+)/g, '$1')

  return value.replace(/\uE000(\d+)\uE001/g, (_, index) => (
    protectedCode[Number(index)] ?? ''
  ))
}
