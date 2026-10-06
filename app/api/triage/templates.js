// ARJE /get-help email templates (v1.7, October 6, 2026)
//
// Copied verbatim from the five SendGrid Dynamic Templates the relay used
// through v1.6 (each had one version, "v1 initial", last edited May 9, 2026).
// Subject and HTML are byte-for-byte the SendGrid copies. Plain text: the
// three <p> templates keep SendGrid's generated text; the two pre-wrap
// templates use the div's own text so the newlines survive.
//
// Tokens use the Handlebars subset renderTemplate() in route.js supports:
// {{name}} and {{#if name}}...{{else}}...{{/if}} (not nested).
//
// v1.7.1 (October 6, 2026): phone number in the four customer templates
// changed from (702) 583-7037 (retired Twilio number) to (702) 850-6401.
// No other wording changed.

export const TEMPLATES = {
  internal: {
    // SendGrid d-e9b2ff3b71464aaebcd359a75ff6e4e9, version f9e0df8b-360e-4377-b679-ed855a82f527
    subject: "[{{triage_bucket}}] {{business_name}} — bookkeeping help request",
    html: "<html><body><div style=\"white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #222;\">TRIAGE BUCKET: {{triage_bucket}}\nRecommended next action: {{triage_action}}\n\n────────────────────────────────────────\nSUBMISSION DETAILS\n────────────────────────────────────────\n\nBusiness name:     {{business_name}}\nContact:           {{contact_name}}\nEmail:             {{contact_email}}\nPhone:           {{phone}}\nIndustry:          {{industry}}{{#if business_type_other}} — {{business_type_other}}{{/if}}\nBooks today:       {{current_state}}\nMonths behind:     {{months_behind}}\nMonthly volume:    {{monthly_volume}}\nService needed:    {{service_need}}\n#1 bottleneck:   {{blocker}}\n\n────────────────────────────────────────\nBOT CHECK\n────────────────────────────────────────\n\nHoneypot field:    {{#if honeypot_filled}}⚠️ FILLED with: \"{{honeypot_value}}\" — likely bot{{else}}empty (clean){{/if}}\n\n────────────────────────────────────────\n\nSubmission record: {{submission_id}}\nReply directly:    {{contact_email}}\nTime received:     {{timestamp_utc}}\n</div></body></html>",
    text: "TRIAGE BUCKET: {{triage_bucket}}\nRecommended next action: {{triage_action}}\n\n────────────────────────────────────────\nSUBMISSION DETAILS\n────────────────────────────────────────\n\nBusiness name:     {{business_name}}\nContact:           {{contact_name}}\nEmail:             {{contact_email}}\nPhone:           {{phone}}\nIndustry:          {{industry}}{{#if business_type_other}} — {{business_type_other}}{{/if}}\nBooks today:       {{current_state}}\nMonths behind:     {{months_behind}}\nMonthly volume:    {{monthly_volume}}\nService needed:    {{service_need}}\n#1 bottleneck:   {{blocker}}\n\n────────────────────────────────────────\nBOT CHECK\n────────────────────────────────────────\n\nHoneypot field:    {{#if honeypot_filled}}⚠️ FILLED with: \"{{honeypot_value}}\" — likely bot{{else}}empty (clean){{/if}}\n\n────────────────────────────────────────\n\nSubmission record: {{submission_id}}\nReply directly:    {{contact_email}}\nTime received:     {{timestamp_utc}}\n",
  },
  hot_cleanup: {
    // SendGrid d-437300a3dc434cf6bc9b59d37585f2e6, version fca85cb6-9523-4a17-be57-b64a20d1e793
    subject: "Re: your message about your books",
    html: "<html><body><div style=\"white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #222;\">Hi {{first_name}},\n\nThanks for reaching out — I read your note. {{months_behind}} months of backlog is very workable; cleanup is mostly mechanical once someone who's done it before is on it.\n\nRather than throw numbers at you over email, I'd rather hear the specifics and give you a straight answer. Reply here with a couple of times that work this week and I'll set up a quick call — or call or text me directly at the number below.\n\nTalk soon,\n\nArnold Dizon\n\nARJE Bookkeeping & Tax Services\n\n(702) 850-6401\n\n</div></body></html>",
    text: "Hi {{first_name}},\n\nThanks for reaching out — I read your note. {{months_behind}} months of backlog is very workable; cleanup is mostly mechanical once someone who's done it before is on it.\n\nRather than throw numbers at you over email, I'd rather hear the specifics and give you a straight answer. Reply here with a couple of times that work this week and I'll set up a quick call — or call or text me directly at the number below.\n\nTalk soon,\n\nArnold Dizon\n\nARJE Bookkeeping & Tax Services\n\n(702) 850-6401\n",
  },
  warm_recurring: {
    // SendGrid d-e8e068117636450d8c3e6c8e95718114, version 703f6265-ef9e-4283-ab33-19c46f5317cc
    subject: "Re: your message about your books",
    html: "<div style=\"font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;\"> <p>Hi {{contact_name}},</p> <p>Thanks for reaching out about ongoing bookkeeping for {{business_name}} — I got your request and read through it.</p> <p>It sounds like you're after someone to keep the books current month to month, which is very much what I do. Before I suggest the right fit, I'd like to understand a bit more about how {{business_name}} runs — every set of books is a little different.</p> <p>I'll follow up shortly to set up a short call. If it's easier, just reply here with a couple of times that work and I'll send an invite.</p> <p>Talk soon,<br> Arnold Dizon<br> ARJE Bookkeeping &amp; Tax Services<br> (702) 850-6401</p> </div>",
    text: "Hi {{contact_name}},\n\nThanks for reaching out about ongoing bookkeeping for {{business_name}} — I got your request and read through it.\n\nIt sounds like you're after someone to keep the books current month to month, which is very much what I do. Before I suggest the right fit, I'd like to understand a bit more about how {{business_name}} runs — every set of books is a little different.\n\nI'll follow up shortly to set up a short call. If it's easier, just reply here with a couple of times that work and I'll send an invite.\n\nTalk soon,\nArnold Dizon\nARJE Bookkeeping & Tax Services\n(702) 850-6401",
  },
  discovery: {
    // SendGrid d-beada329ad014da2aa3acd76f87333c9, version 10b4b469-dcd7-43ce-85b5-e2611c71ca68
    subject: "Re: your message about your books",
    html: "<div style=\"font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;\"> <p>Hi {{contact_name}},</p> <p>Thanks for reaching out — I got your message about {{business_name}} and wanted to reply personally.</p> <p>From what you've shared, I want to make sure I understand where things stand before pointing you in the right direction. Sometimes that's a quick recommendation by email; sometimes a 15-minute call saves us both time.</p> <p>I'll follow up shortly. If you'd like, reply here with a little more about what's prompting the change and a couple of times you're free, and we'll take it from there.</p> <p>Best,<br> Arnold Dizon<br> ARJE Bookkeeping &amp; Tax Services<br> (702) 850-6401</p> </div>",
    text: "Hi {{contact_name}},\n\nThanks for reaching out — I got your message about {{business_name}} and wanted to reply personally.\n\nFrom what you've shared, I want to make sure I understand where things stand before pointing you in the right direction. Sometimes that's a quick recommendation by email; sometimes a 15-minute call saves us both time.\n\nI'll follow up shortly. If you'd like, reply here with a little more about what's prompting the change and a couple of times you're free, and we'll take it from there.\n\nBest,\nArnold Dizon\nARJE Bookkeeping & Tax Services\n(702) 850-6401",
  },
  selfserve: {
    // SendGrid d-aa60f167c5fc4fc183da5a68935fe5e0, version 43efd63a-e9ac-464d-9e01-e665ef012e61
    subject: "Re: your message about your books",
    html: "<div style=\"font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;\"> <p>Hi {{contact_name}},</p> <p>Thanks for reaching out — sounds like you're looking to handle {{business_name}}'s books yourself with the right tools, which is a smart way to start.</p> <p>I've built a few that clients lean on most — the Bookkeeper's Ultimate Bundle is the usual starting point. You can find it here: <a href=\"https://arjebookkeeping.gumroad.com/l/ultimate-bundle\">arjebookkeeping.gumroad.com/l/ultimate-bundle</a></p> <p>If you get in there and aren't sure it's the right fit, just reply to this email and I'll point you to what makes sense.</p> <p>Best,<br> Arnold Dizon<br> ARJE Bookkeeping &amp; Tax Services<br> (702) 850-6401</p> </div>",
    text: "Hi {{contact_name}},\n\nThanks for reaching out — sounds like you're looking to handle {{business_name}}'s books yourself with the right tools, which is a smart way to start.\n\nI've built a few that clients lean on most — the Bookkeeper's Ultimate Bundle is the usual starting point. You can find it here: arjebookkeeping.gumroad.com/l/ultimate-bundle ( https://arjebookkeeping.gumroad.com/l/ultimate-bundle )\n\nIf you get in there and aren't sure it's the right fit, just reply to this email and I'll point you to what makes sense.\n\nBest,\nArnold Dizon\nARJE Bookkeeping & Tax Services\n(702) 850-6401",
  },
}
