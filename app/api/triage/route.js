// ARJE /get-help triage relay — v1.2 (Day 3 multipart parser fix)
// Jotform form 261278593405059 → POST /api/triage → SendGrid Dynamic Templates
//
// v1.2 changes (May 10, 2026 — Phase 6.3 second iteration):
//   - DIAGNOSED: Jotform's actual webhook content-type is multipart/form-data,
//     NOT application/x-www-form-urlencoded as v1.1 assumed. The 10:59 AM
//     PT submission landed at the relay with a multipart boundary as the
//     entire body; URLSearchParams treated the boundary line as a single
//     key, resulting in all-EMPTY canonical fields.
//   - parseJotformBody now detects multipart/form-data via the content-type
//     header and uses the Web-standard Request.formData() API (Node 20
//     native) to parse properly. Compound name fields (q4_yourName[first],
//     q4_yourName[last]) are reconstructed from separate multipart parts.
//   - rawRequest envelope path is preserved as fallback (in case Jotform's
//     webhook config changes or some sends use the URL-encoded path).
//   - JSON content-type path is preserved for manual curl tests.
//
// v1.1 changes (May 10, 2026 — Phase 6.3 first iteration):
//   - parseJotformBody unwrapped Jotform's `rawRequest` JSON-string envelope
//     (assumption that turned out to be wrong for multipart sends; kept as
//     fallback).
//   - FIELD_MAP updated to q{N}_{questionname} format.
//   - Compound fields (yourName.first/.last) flattened during extraction.
//   - Verbose diagnostic logging added.
//
// Architecture:
//   1. Receive Jotform's webhook POST (multipart/form-data — primary path)
//   2. Parse via Request.formData() → flat object with multipart fields
//      Compound names flattened: q4_yourName[first] + q4_yourName[last]
//      → q4_yourName: { first: "...", last: "..." } for extractor compatibility
//   3. Map raw fields to canonical names via FIELD_FALLBACKS
//   4. Bot rejection: if honeypot field has any value, return 200 OK silently
//   5. Triage: compute bucket (A/B/C/D) from canonical fields
//   6. Fire internal notification (Template 1) with all fields + triage_bucket
//   7. Fire customer-facing template (2/3/4/5 based on bucket)
//   8. Return 200 OK to Jotform
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
  // Canonical name      →  Jotform rawRequest key
  business_name:           'q1_businessName',
  contact_name:            'q4_yourName',          // compound: .first .last
  contact_email:           'q3_emailAddress',
  industry:                'q5_whatIndustry',
  industry_other:          'q6_industry_other',
  current_state:           'q7_whereAre',
  months_behind:           'q8_howMany',
  monthly_volume:          'q10_monthlyTransaction',
  service_need:            'q11_service_need',
  honeypot:                'q15_website_url',
}

// Fallback aliases — if Jotform sends `pretty` keys or alternate shapes,
// we still resolve. Keys checked in order; first non-empty wins.
const FIELD_FALLBACKS = {
  business_name:   ['q1_businessName', 'businessName', 'Business Name'],
  contact_name:    ['q4_yourName', 'yourName', 'Your Name'],
  contact_email:   ['q3_emailAddress', 'emailAddress', 'Email Address', 'email'],
  industry:        ['q5_whatIndustry', 'whatIndustry', 'What Industry'],
  industry_other:  ['q6_industry_other', 'industry_other'],
  current_state:   ['q7_whereAre', 'whereAre', 'Where Are You'],
  months_behind:   ['q8_howMany', 'howMany', 'How Many Months'],
  monthly_volume:  ['q10_monthlyTransaction', 'monthlyTransaction', 'Monthly Transactions'],
  service_need:    ['q11_service_need', 'service_need', 'Service Need'],
  honeypot:        ['q15_website_url', 'website_url'],
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

    return { source: 'multipart', flat, inner: null }
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
// ──────────────────────────────────────────────────────────────────────
async function sendTemplate({ to, templateId, fromName, dynamicData }) {
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
      business_name:   fields.business_name   ? '✓' : 'EMPTY',
      contact_name:    fields.contact_name    ? '✓' : 'EMPTY',
      contact_email:   fields.contact_email   ? '✓' : 'EMPTY',
      industry:        fields.industry        ? '✓' : 'EMPTY',
      current_state:   fields.current_state   ? '✓' : 'EMPTY',
      months_behind:   fields.months_behind   ? '✓' : 'EMPTY',
      monthly_volume:  fields.monthly_volume  ? '✓' : 'EMPTY',
      service_need:    fields.service_need    ? '✓' : 'EMPTY',
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
    })

    // 6. Fire customer-facing template (only if we have a valid contact email)
    let customerResult = { skipped: true, reason: 'no contact_email' }
    if (fields.contact_email && fields.contact_email.includes('@')) {
      const customerConfig = TEMPLATE_CONFIG[triage.key]
      const customerData = {
        contact_name:  fields.contact_name  || 'there',
        business_name: fields.business_name || 'your business',
        months_behind: fields.months_behind || '',
      }

      await sendTemplate({
        to:          fields.contact_email,
        templateId:  customerConfig.id,
        fromName:    customerConfig.from_name,
        dynamicData: customerData,
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
    version:   '1.2.0',
    buckets:   ['hot_cleanup', 'warm_recurring', 'discovery', 'selfserve'],
    timestamp: new Date().toISOString(),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
