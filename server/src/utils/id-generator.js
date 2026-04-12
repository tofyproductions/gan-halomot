const { v4: uuidv4 } = require('uuid');

function generateUniqueId(prefix = 'REG') {
  return `${prefix}_${Date.now()}`;
}

function generateAccessToken() {
  return uuidv4();
}

/**
 * Validate Israeli ID number (Teudat Zehut)
 */
function isValidIsraeliID(id) {
  const str = String(id).trim();
  if (str.length > 9 || str.length < 5 || isNaN(str)) return false;
  const padded = str.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let k = ((i % 2) + 1) * Number(padded[i]);
    if (k > 9) k -= 9;
    sum += k;
  }
  return sum % 10 === 0;
}

module.exports = { generateUniqueId, generateAccessToken, isValidIsraeliID };
