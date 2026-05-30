// ARJE /get-help triage relay — v1.5 (May 29, 2026 — customer-send deliverability fix)
// Jotform form 261375188338062 → POST /api/triage → SendGrid Dynamic Templates
//
// v1.5 changes (May 29, 2026 — Phase B deliverability):
//   - Customer autoresponder was landing in Gmail Promotions, not Primary.
//   - Root cause: code set NO tracking_settings on either send, so SendGrid
//     account-level Mail Settings (open + click tracking) applied globally —
//     injecting the open pixel + link-rewriting that read as "marketing."
//   - Fix: sendTemplate now accepts an optional `trackingSettings` param.
//     The CUSTOMER send passes it to disable open/click/subscription tracking
//     for that send only. The INTERNAL triage send omits it → account default
//     applies → internal pixel left intact (unchanged behavior).
//   - No header/asm/categories changes needed — code never set any. The only
//     bulk artifact risk (List-Unsubscribe footer) comes from account-level
//     subscription tracking, neutralized by subscription_tracking.enable=false
//     on the customer send.
//   - GET version bumped 1.3.0 → 1.5.0 (also closes the stale-version cleanup item).
//
// v1.3 changes (May 10, 2026 — Phase 6.3 third iteration):
//   - DIAGNOSED: Jotform actually sends a HYBRID payload — the wire format
//     is multipart/form-data (per v1.2 diagnosis), but inside that multipart
//     payload there is ONE part named `rawRequest` whose value is a JSON
//     string containing all the actual form fields. The other multipart
//     parts (`formID`, `submissionID`, `pretty`) are envelope metadata.
//   - v1.2's multipart branch correctly extracted the parts but treated
//     `rawRequest` as just another flat key, never unwrapping it as a JSON
//     envelope. Result: all canonical fields resolved to EMPTY for the
//     second time at the 17:59 UTC + 23:49 UTC live windows.
//   - Diagnostic confirmation via Vercel MCP keyword probes (May 10, 23:55 UTC):
//       query="compound parents" → matched → multipart branch fired ✓
//       query="rawRequest"       → matched → rawRequest IS a multipart part ✓
//       query="q1_businessName"  → no match → fields not at multipart root ✓
//     Together these confirm: multipart parser ran, rawRequest is a part,
//     canonical field IDs are NOT direct multipart parts.
//   - The fix: inside the multipart branch, after building `flat` from
//     multipart parts, check if flat.rawRequest is a JSON string and
//     unwrap it into `inner` — same logic the v1.1 urlencoded fallback
//     path already has. Net code addition: ~12 lines inside the multipart
//     branch.
//   - extractFields requires no change — it already prefers `parsed.inner`
//     over `parsed.flat` when both exist (per v1.1 behavior).
//
// v1.2 changes (May 10, 2026 — Phase 6.3 second iteration):
//   - parseJotformBody added multipart/form-data as primary path via
//     Request.formData(). Compound name fields (q4_yourName[first]/[last])
//     reconstructed into nested objects. Did not unwrap rawRequest inside
//     multipart — that's v1.3's job.
//
// v1.1 changes (May 10, 2026 — Phase 6.3 first iteration):
//   - parseJotformBody unwrapped Jotform's `rawRequest` JSON-string envelope
//     under urlencoded path. Assumption that content-type was urlencoded
//     turned out wrong (it's multipart). Kept as fallback in v1.2+.
//   - FIELD_MAP updated to q{N}_{questionname} format.
//   - Compound fields (yourName.first/.last) flattened during extraction.
//   - Verbose diagnostic logging added.
//
// Architecture:
//   1. Receive Jotform's webhook POST (multipart/form-data — primary path)
//   2. Parse via Request.formData() → flat object with multipart parts
//   3. Check if flat.rawRequest exists as JSON string → unwrap to inner
//   4. extractFields reads inner first (where the real fields live),
//      falls back to flat (envelope metadata)
//   5. Bot rejection: if honeypot field has any value, return 200 OK silently
//   6. Triage: compute bucket (A/B/C/D) from canonical fields
//   7. Fire internal notification (Template 1) with all fields + triage_bucket
//   8. Fire customer-facing template (2/3/4/5 based on bucket)
//   9. Return 200 OK to Jotform
//
// On any error: log to Vercel runtime logs, return 200 OK to Jotform anyway
// (so Jotform doesn't queue retry storms — we'd rather lose the email than dupe it)

export const runtime = 'nodejs'

// ──────────────────────────────────────────────────────────────────────
// Locked field mapping (Day 3 — corrected to Jotform webhook payload shape)
// Jotform's webhook rawRequest JSON uses keys like `q1_businessName`,
// where the leading `q{N}_` is the question number from form construction.
// Compound fields (full name) have nested subkeys: `q4_yourName.first`.
// ──────────────────────────────────────────────────────────────────────
const FIELD_MAP = {
  // Canonical name      →  Jotform rawRequest key (form 261375188338062)
  // Note: FIELD_MAP is informational only — actual resolution uses FIELD_FALLBACKS below.
  first_name:              'q2_q2_textbox0',
  last_name:               'q3_q3_textbox1',
  business_name:           'q10_businessName',
  contact_email:           'q4_q4_email2',
  phone:                   'q5_q5_phone3',
  industry:                'q6_q6_dropdown4',
  months_behind:           'q7_q7_number5',
  monthly_volume:          'q11_approximateMonthly',
  service_need:            'q12_whatYoure',
  blocker:                 'q8_q8_textarea6',
  honeypot:                'website',
  current_state:       'q13_whatsThe',
  business_type_other: 'q14_pleaseTell',
}

// Fallback aliases — if Jotform sends `pretty` keys or alternate shapes,
// we still resolve. Keys checked in order; first non-empty wins.
const FIELD_FALLBACKS = {
  first_name:      ['q2_q2_textbox0', 'q2_firstName', 'firstName'],
  last_name:       ['q3_q3_textbox1', 'q3_lastName', 'lastName'],
  business_name:   ['q10_businessName', 'businessName'],
  contact_email:   ['q4_q4_email2', 'q4_email', 'email'],
  phone:           ['q5_q5_phone3', 'q5_phone', 'phone'],
  industry:        ['q6_q6_dropdown4', 'q6_businessType', 'businessType'],
  months_behind:   ['q7_q7_number5', 'q7_monthsBehind', 'monthsBehind'],
  monthly_volume:  ['q11_approximateMonthly', 'monthlyVolume'],
  service_need:    ['q12_whatYoure', 'q12_whatYouLookingFor', 'serviceNeed'],
  blocker:         ['q8_q8_textarea6', 'q8_blocker', 'blocker'],
  honeypot:        ['website', 'q15_website_url'],
  current_state:       ['q13_whatsThe'],
  business_type_other: ['q14_pleaseTell'],
}

// SendGrid Dynamic Template IDs (locked from Phase 4, May 9)
const TEMPLATE_CONFIG = {
  internal: {
    id:        'd-e9b2ff3b71464aaebcd359a75ff6e4e9',
    from_name: 'ARJE /get-help triage',
  },
  hot_cleanup: {
    id:        'd-437300a3dc434cf6bc9b59d37585f2e6',
    from_name: 'Arnold Dizon | ARJE Bookkeeping',
  },
  warm_recurring: {
    id:        'd-e8e068117636450d8c3e6c8e95718114',
    from_name: 'Arnold Dizon | ARJE Bookkeeping',
  },
  discovery: {
    id:        'd-beada329ad014da2aa3acd76f87333c9',
    from_name: 'Arnold Dizon | ARJE Bookkeeping',
  },
  selfserve: {
    id:        'd-aa60f167c5fc4fc183da5a68935fe5e0',
    from_name: 'Arnold Dizon | ARJE Bookkeeping',
  },
}

const FROM_EMAIL    = 'arnold@arjebookkeeping.com'
const REPLY_TO      = 'arnold@arjebookkeeping.com'
const INTERNAL_TO   = 'arnold@arjebookkeeping.com'

// ──────────────────────────────────────────────────────────────────────
// Per-send tracking override for the CUSTOMER autoresponder (v1.5).
// Disables SendGrid open pixel, click-rewriting, and the unsubscribe footer
// for the customer send only, so Gmail classifies it as a 1:1 reply (Primary)
// rather than marketing (Promotions). Internal triage send does NOT use this.
const CUSTOMER_TRACKING_OFF = {
  click_tracking:        { enable: false, enable_text: false },
  open_tracking:         { enable: false },
  subscription_tracking: { enable: false },
}

// ──────────────────────────────────────────────────────────────────────
// Body parser — Jotform webhook envelope handling
//
// Jotform sends webhooks as MULTIPART/FORM-DATA in production (confirmed
// May 10, 2026 via Vercel runtime logs from Phase 6.3 second iteration).
// Some test/curl sends may use other shapes; we handle three paths:
//
//   1. multipart/form-data — PRIMARY. Use Request.formData() (Node 20
//      native, Web standard). Compound name fields appear as separate
//      parts: q4_yourName[first] and q4_yourName[last]. We reconstruct
//      them into a single nested object so the extractor sees the same
//      shape regardless of wire format.
//
//   2. application/x-www-form-urlencoded with rawRequest envelope —
//      FALLBACK. v1.1's path. Some Jotform configs send this shape
//      instead of multipart; we preserve compatibility.
//
//   3. application/json — FALLBACK. Used by manual curl tests and any
//      future direct-API integration. Treats body as flat object.
//
// We log the chosen path so future bugs surface immediately.
// ──────────────────────────────────────────────────────────────────────
async function parseJotformBody(req) {
  const contentType = req.headers.get('content-type') || ''

  // Path 1: multipart/form-data (Jotform's actual webhook wire format)
  if (contentType.includes('multipart/form-data')) {
    const fd = await req.formData()
    const flat = {}
    const compounds = {}  // accumulator for q{N}_name[first], [last], etc.

    for (const [key, value] of fd.entries()) {
      // value can be a string or a File object; we only use strings.
      const stringValue = typeof value === 'string' ? value : ''

      // Detect compound subkey pattern: parentKey[subkey]
      const compoundMatch = key.match(/^(.+?)\[([^\]]+)\]$/)
      if (compoundMatch) {
        const [, parent, sub] = compoundMatch
        if (!compounds[parent]) compounds[parent] = {}
        compounds[parent][sub] = stringValue
      } else {
        flat[key] = stringValue
      }
    }

    // Merge compounds back into flat as nested objects
    for (const parent of Object.keys(compounds)) {
      flat[parent] = compounds[parent]
    }

    console.log('[get-help-triage] body parse: multipart/form-data,',
      'flat keys:', Object.keys(flat).join(','),
      '| compound parents:', Object.keys(compounds).join(',') || 'none')

    // v1.3 FIX: Jotform multipart payloads contain a `rawRequest` part whose
    // value is a JSON string of the actual form fields. Unwrap it here so
    // extractFields sees the inner field object, not just envelope metadata
    // (formID / submissionID / pretty / rawRequest at the multipart root).
    let inner = null
    if (typeof flat.rawRequest === 'string' && flat.rawRequest.trim().length > 0) {
      try {
        inner = JSON.parse(flat.rawRequest)
        console.log('[get-help-triage] body parse: multipart contained rawRequest envelope,',
          'inner keys:', Object.keys(inner).join(','))
      } catch (parseErr) {
        console.error('[get-help-triage] multipart rawRequest JSON parse failed:',
          parseErr.message,
          '\n  rawRequest first 500 chars:',
          flat.rawRequest.slice(0, 500))
        inner = null
      }
    }

    return { source: inner ? 'multipart+rawRequest' : 'multipart', flat, inner }
  }

  // Path 2: application/json (likely a manual test POST, not Jotform)
  if (contentType.includes('application/json')) {
    const json = await req.json()
    console.log('[get-help-triage] body parse: json content-type, keys:',
      Object.keys(json).join(','))
    return { source: 'json', flat: json, inner: json.rawRequest || null }
  }

  // Path 3: form-urlencoded with rawRequest envelope (v1.1 fallback)
  const text = await req.text()
  const params = new URLSearchParams(text)
  const flat = {}
  for (const [key, value] of params.entries()) {
    flat[key] = value
  }

  let inner = null
  if (typeof flat.rawRequest === 'string' && flat.rawRequest.trim().length > 0) {
    try {
      inner = JSON.parse(flat.rawRequest)
      console.log('[get-help-triage] body parse: form-encoded with rawRequest,',
        'inner keys:', Object.keys(inner).join(','))
    } catch (parseErr) {
      console.error('[get-help-triage] rawRequest JSON parse failed:',
        parseErr.message,
        '\n  rawRequest first 500 chars:',
        flat.rawRequest.slice(0, 500))
      inner = null
    }
  } else {
    console.log('[get-help-triage] body parse: form-encoded, no rawRequest envelope.',
      'flat keys:', Object.keys(flat).join(','))
  }

  return {
    source: inner ? 'rawRequest' : 'flat',
    flat,
    inner,
  }
}

// ──────────────────────────────────────────────────────────────────────
// Field extraction — resolves canonical field names from parsed body.
// Looks first in inner (rawRequest contents), then in flat (top-level)
// with fallback aliases. Compound fields (Jotform name widget) are
// flattened: yourName: { first: "Jane", last: "Doe" } → "Jane Doe".
// ──────────────────────────────────────────────────────────────────────
function extractFields(parsed) {
  const sources = [parsed.inner, parsed.flat].filter(Boolean)
  const out = {}

  for (const canonical of Object.keys(FIELD_FALLBACKS)) {
    const candidates = FIELD_FALLBACKS[canonical]
    let value = ''

    for (const src of sources) {
      for (const key of candidates) {
        const raw = src[key]
        if (raw === undefined || raw === null) continue

        // Compound (object) — flatten to "first last" if name-shaped,
        // otherwise JSON-stringify so we can see what came in.
        if (typeof raw === 'object') {
          if (raw.first || raw.last) {
            value = [raw.first, raw.last].filter(Boolean).join(' ').trim()
          } else if (raw.full) {
            value = String(raw.full).trim()
          } else {
            value = JSON.stringify(raw)
          }
        } else {
          value = String(raw).trim()
        }

        if (value.length > 0) break
      }
      if (value.length > 0) break
    }

    out[canonical] = value
  }

  // Post-extraction derivation: contact_name from split first/last fields.
  // The form schema split the original compound name field into two separate
  // top-level fields. Join here so downstream code expecting contact_name
  // continues to work without modification.
  out.contact_name = [out.first_name, out.last_name].filter(Boolean).join(' ').trim()

  return out
}

// ──────────────────────────────────────────────────────────────────────
// Triage — compute bucket from canonical fields.
// Bucket A (hot_cleanup):    cleanup needed, behind 3+ months OR shoebox state
// Bucket B (warm_recurring): wants ongoing monthly bookkeeping, current
// Bucket C (discovery):      unclear, needs conversation (default fallthrough)
// Bucket D (selfserve):      explicitly wants templates/DIY tools
// ──────────────────────────────────────────────────────────────────────
function computeTriage(fields) {
  const need = (fields.service_need || '').toLowerCase()
  const state = (fields.current_state || '').toLowerCase()
  const months = (fields.months_behind || '').toLowerCase()

  // D — self-serve signal first (explicit DIY ask)
  if (need.includes('template') || need.includes('diy') || need.includes('self')) {
    return { key: 'selfserve', label: 'D — Self-serve' }
  }

  // A — cleanup signal: shoebox/spreadsheet state OR 3+ months behind
  const cleanupSignals = ['cleanup', 'clean up', 'catch up', 'catch-up', 'behind']
  const stateSignals   = ['shoebox', 'spreadsheet', 'nothing']
  const behindSignals  = ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '+', 'year']

  if (cleanupSignals.some(s => need.includes(s)) ||
      stateSignals.some(s => state.includes(s)) ||
      behindSignals.some(s => months.includes(s))) {
    return { key: 'hot_cleanup', label: 'A — Hot Cleanup' }
  }

  // B — warm recurring: explicit monthly/ongoing ask
  if (need.includes('month') || need.includes('ongoing') || need.includes('recurring')) {
    return { key: 'warm_recurring', label: 'B — Warm Recurring' }
  }

  // C — discovery default
  return { key: 'discovery', label: 'C — Discovery' }
}

// ──────────────────────────────────────────────────────────────────────
// SendGrid mail/send caller
//   trackingSettings (optional): when provided, sets per-send tracking_settings,
//   overriding SendGrid account-level Mail Settings for THIS send only.
// ──────────────────────────────────────────────────────────────────────
async function sendTemplate({ to, templateId, fromName, dynamicData, trackingSettings }) {
  const apiKey = process.env.SENDGRID_API_KEY
  if (!apiKey) {
    throw new Error('SENDGRID_API_KEY env var not set')
  }

  const body = {
    personalizations: [{
      to: [{ email: to }],
      dynamic_template_data: dynamicData,
    }],
    from: { email: FROM_EMAIL, name: fromName },
    reply_to: { email: REPLY_TO },
    template_id: templateId,
  }

  // v1.5: per-send tracking override (customer send only). Omitting this on the
  // internal send leaves SendGrid account-level tracking in place for it.
  if (trackingSettings) {
    body.tracking_settings = trackingSettings
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`SendGrid mail/send failed: ${response.status} — ${errText}`)
  }

  return { ok: true, status: response.status }
}

// ──────────────────────────────────────────────────────────────────────
// Main webhook handler
// ──────────────────────────────────────────────────────────────────────
export async function POST(req) {
  const startTime = Date.now()

  try {
    // 1. Parse incoming webhook body (with envelope unwrap)
    const parsed = await parseJotformBody(req)

    // 2. Map to canonical fields
    const fields = extractFields(parsed)

    // 2a. DIAGNOSTIC LOG (Day 3 — verbose for verification window;
    //     dial back after Phase 6.4 production ENABLE)
    console.log('[get-help-triage] resolved fields:', JSON.stringify({
      source:          parsed.source,
      first_name:      fields.first_name      ? '✓' : 'EMPTY',
      last_name:       fields.last_name       ? '✓' : 'EMPTY',
      business_name:   fields.business_name   ? '✓' : 'EMPTY',
      contact_name:    fields.contact_name    ? '✓' : 'EMPTY',
      contact_email:   fields.contact_email   ? '✓' : 'EMPTY',
      phone:           fields.phone           ? '✓' : 'EMPTY',
      industry:        fields.industry        ? '✓' : 'EMPTY',
      months_behind:   fields.months_behind   ? '✓' : 'EMPTY',
      monthly_volume:  fields.monthly_volume  ? '✓' : 'EMPTY',
      service_need:    fields.service_need    ? '✓' : 'EMPTY',
      blocker:         fields.blocker         ? '✓' : 'EMPTY',
      honeypot:        fields.honeypot        ? '⚠️ FILLED' : 'empty (good)',
    }))

    // 3. Bot rejection — silent 200 OK, no emails fired
    if (fields.honeypot && fields.honeypot.length > 0) {
      console.log('[get-help-triage] BOT REJECTED — honeypot filled:', JSON.stringify({
        honeypot_value: fields.honeypot,
        contact_email:  fields.contact_email,
        ip:             req.headers.get('x-forwarded-for') || 'unknown',
      }))
      return new Response(JSON.stringify({ ok: true, route: 'bot-rejected' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    // 4. Compute triage
    const triage = computeTriage(fields)

    // 5. Fire internal notification (always)
    const submissionId = (parsed.flat && parsed.flat.submissionID) ||
                        (parsed.inner && parsed.inner.submissionID) ||
                        'unknown'

    const internalData = {
      ...fields,
      triage_bucket:  triage.label,
      triage_action:  triage.key,
      submission_id:  submissionId,
      timestamp_utc:  new Date().toISOString(),
    }

    await sendTemplate({
      to:          INTERNAL_TO,
      templateId:  TEMPLATE_CONFIG.internal.id,
      fromName:    TEMPLATE_CONFIG.internal.from_name,
      dynamicData: internalData,
      // NOTE: no trackingSettings → internal triage send keeps account-level
      // tracking (pixel intact). Intentional per v1.5.
    })

    // 6. Fire customer-facing template (only if we have a valid contact email)
    let customerResult = { skipped: true, reason: 'no contact_email' }
    if (fields.contact_email && fields.contact_email.includes('@')) {
      const customerConfig = TEMPLATE_CONFIG[triage.key]
      const customerData = {
        contact_name:  fields.contact_name  || 'there',
        first_name:    fields.first_name    || 'there',
        business_name: fields.business_name || 'your business',
        months_behind: fields.months_behind || '',
      }

      await sendTemplate({
        to:          fields.contact_email,
        templateId:  customerConfig.id,
        fromName:    customerConfig.from_name,
        dynamicData: customerData,
        trackingSettings: CUSTOMER_TRACKING_OFF,   // v1.5: keep customer reply in Primary
      })
      customerResult = { sent: true, template: triage.key }
    }

    const elapsed = Date.now() - startTime
    console.log('[get-help-triage] success:', JSON.stringify({
      bucket:         triage.key,
      contact_email:  fields.contact_email,
      submission_id:  submissionId,
      elapsed_ms:     elapsed,
    }))

    return new Response(JSON.stringify({
      ok:         true,
      bucket:     triage.key,
      internal:   'sent',
      customer:   customerResult,
      elapsed_ms: elapsed,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  } catch (err) {
    // Log error but return 200 OK so Jotform doesn't retry-storm
    console.error('[get-help-triage] error:', err.message, err.stack)
    return new Response(JSON.stringify({
      ok:    false,
      error: 'relay error logged — see Vercel runtime logs',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET handler — health check / sanity ping
// curl https://[domain]/api/triage → returns version + triage config
// ──────────────────────────────────────────────────────────────────────
export async function GET() {
  return new Response(JSON.stringify({
    ok:        true,
    service:   'ARJE /get-help triage relay',
    version:   '1.5.0',
    buckets:   ['hot_cleanup', 'warm_recurring', 'discovery', 'selfserve'],
    timestamp: new Date().toISOString(),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
