/**
 * A number, kept in the order it was written.
 *
 * Hebrew text is laid out right to left, and the browser decides the direction
 * of each run inside it. Digits are handled correctly on their own — but the
 * moment a neutral character sits between two digit runs, the neutrals take
 * the paragraph's direction and the whole thing is laid out backwards.
 *
 * That is not theoretical. "05••••••56" — a masked phone number — displayed to
 * a parent as "56••••••05", telling them the code had gone to a number that
 * was not theirs. The digits were right and the order was wrong, which is the
 * worst kind of wrong: it looks like a bug in the data.
 *
 * `isolate` tells the browser to work out this run's direction by itself and
 * then place the finished result, rather than letting the sentence around it
 * decide. Use it for any phone number, ID number or masked value shown inside
 * Hebrew prose.
 */
export default function Ltr({ children }) {
  return (
    <bdi dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {children}
    </bdi>
  );
}
