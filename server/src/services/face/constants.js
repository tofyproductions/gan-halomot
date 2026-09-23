/**
 * Every number that decides whether a child is recognised.
 *
 * All of these were MEASURED on 200 real photographs from a class WhatsApp
 * group before any of this was designed — they are not defaults copied from a
 * tutorial, and changing one without repeating that measurement silently
 * changes who gets tagged. The method and the full results are in
 * FACE_RECOGNITION_PLAN.md at the repo root.
 *
 * They live in one file because the same figure is needed by the scanner, the
 * matcher, the reference store and the tests, and a threshold written down
 * twice is a threshold that will eventually disagree with itself.
 */

module.exports = {
  /**
   * How sure the detector must be that a rectangle is a face at all.
   *
   * At 0.50 the test produced a cluster of eleven "faces" that were ears, the
   * backs of heads and a doll, with a median confidence of 56% — against
   * 76-84% for every cluster that was really a child. Raising the floor to
   * 0.65 removed all eleven and kept 88% of the genuine faces.
   */
  DET_SCORE_MIN: 0.65,

  /**
   * Cosine similarity above which two faces are the same child.
   *
   * Measured against 648 pairs that are certainly different children, because
   * two faces in one photograph cannot be the same person: 12 mistakes at
   * 0.40, one at 0.50, and none at 0.55. The product rule is "better silent
   * than wrong" — a wrongly-labelled child is a crisis, a missing photo is a
   * scroll — so the threshold sits at the first value that costs nothing.
   */
  MATCH_THRESHOLD: 0.55,

  /**
   * Reference faces kept per child, most recent first.
   *
   * A one-year-old stops looking like their September photograph by January,
   * so the set rolls rather than accumulates: new confirmed tags push the
   * oldest out, and the system ages with the child instead of hunting for who
   * they used to be.
   */
  REFERENCES_PER_CHILD: 20,

  /**
   * How long a face embedding that is NOT a reference survives.
   *
   * An embedding is biometric data; a tag is not. Once a face has been matched
   * and the photograph labelled, its embedding has done its job and keeping it
   * would build a database of 180,000 biometric templates of children a year
   * instead of 4,400. It is held briefly only so that a child enrolled later
   * can be back-filled into photographs already scanned.
   */
  EMBEDDING_TTL_DAYS: 30,

  /** The detector's input square. Larger finds smaller faces, and costs time. */
  DET_SIZE: 1024,

  /**
   * The detector's own first-pass cut, before DET_SCORE_MIN.
   *
   * Deliberately lower: boxes between the two are still worth seeing in the
   * "who is this?" queue even though they are never auto-tagged.
   */
  DET_RAW_THRESHOLD: 0.5,
};
