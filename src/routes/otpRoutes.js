const express = require("express");
const { requireInternalKey } = require("../middleware/auth");
const otpService = require("../services/otpService");

const router = express.Router();

router.use(requireInternalKey);

/**
 * POST /internal/otp/send
 * body: { channel, to, purpose, tenantId, message? }
 */
router.post("/send", async (req, res) => {
  try {
    const result = await otpService.sendOtp(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * POST /internal/otp/verify
 * body: { to, purpose, tenantId, code }
 */
router.post("/verify", (req, res) => {
  try {
    const result = otpService.verifyOtp(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
