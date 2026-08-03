import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

import {
  EVIDENCE_PASSPORT_SIGNATURE_SEMANTICS,
  EvidencePassportError,
  type DeployBenchEvidencePassport,
  type EvidencePassportSignature,
} from "./passport-types.js";
import {
  passportSignatureMessage,
  verifyEvidencePassport,
} from "./passport-verify.js";

export async function signEvidencePassport(
  input: unknown,
  privateKeyPem: string,
): Promise<DeployBenchEvidencePassport> {
  const verification = await verifyEvidencePassport(input);
  if (!verification.valid) {
    throw new EvidencePassportError(
      "Refusing to sign an invalid evidence passport.",
      verification.issues,
    );
  }
  const passport = input as DeployBenchEvidencePassport;
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new EvidencePassportError(
      `Unable to read the operator private key: ${error instanceof Error ? error.message : "invalid key"}`,
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new EvidencePassportError("Operator signing requires an Ed25519 private key.");
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeySpkiBase64 = publicKeyDer.toString("base64");
  const keyDigest = createHash("sha256").update(publicKeyDer).digest("hex");
  const keyId = `ed25519-sha256-${keyDigest}`;
  if (passport.signatures.some((signature) => signature.keyId === keyId)) {
    throw new EvidencePassportError(`Passport already contains a signature from ${keyId}.`);
  }
  const signature: EvidencePassportSignature = {
    kind: "operator_authorship",
    algorithm: "Ed25519",
    keyId,
    publicKeySpkiBase64,
    signedPayloadSha256: passport.payloadSha256,
    signatureBase64: sign(
      null,
      passportSignatureMessage(passport.payloadSha256),
      privateKey,
    ).toString("base64"),
    semantics: EVIDENCE_PASSPORT_SIGNATURE_SEMANTICS,
  };
  const signed: DeployBenchEvidencePassport = {
    ...passport,
    signatures: [...passport.signatures, signature].sort((left, right) =>
      left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0,
    ),
  };
  const signedVerification = await verifyEvidencePassport(signed);
  if (!signedVerification.valid) {
    throw new EvidencePassportError(
      "The signed passport failed post-signature verification.",
      signedVerification.issues,
    );
  }
  return signed;
}
