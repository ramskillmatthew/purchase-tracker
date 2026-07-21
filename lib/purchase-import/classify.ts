const reversalOrLifecycle = /\b(cancel(?:led|ed|lation)?|refund(?:ed)?|return(?:ed)?|shipp(?:ed|ing|ment)|dispatch(?:ed)?|tracking|on (?:its|the) way|out for delivery|deliver(?:ed|y)|arriv(?:ed|ing)|ready for collection|payment is being sent|payout|order update|order (?:is )?complete(?:d)?)\b/i;
const purchaseConfirmation = /\b(order(?:\s+[A-Z0-9-]+)?\s+(?:confirm(?:ed|ation)|received)|(?:your|the) order (?:has been |is )?(?:confirm(?:ed)|received|placed)|thank you for (?:placing )?(?:an |your )?(?:order|preorder)|thanks for (?:placing )?(?:an |your )?(?:order|preorder)|thank you for your purchase|purchase (?:confirm(?:ed|ation)|receipt)|preorder (?:confirm(?:ed|ation)|receipt)|order (?:details|summary|receipt)|receipt for|payment receipt|invoice)\b/i;

export function isPurchaseConfirmationSubject(subject: string) {
  return !reversalOrLifecycle.test(subject) && purchaseConfirmation.test(subject);
}

export function isPurchaseCandidateSubject(subject: string) {
  return !reversalOrLifecycle.test(subject) && /\b(order|purchase|preorder|receipt|invoice|payment)\b/i.test(subject);
}

/** Named-retailer imports inspect every matching message body; broad mailbox
 * imports retain a conservative header shortlist to avoid reading unrelated mail. */
export function shouldInspectPurchaseHeader(subject: string, namedRetailer: boolean) {
  return namedRetailer || isPurchaseCandidateSubject(subject);
}

export function isPurchaseLifecycleSubject(subject: string) {
  return reversalOrLifecycle.test(subject);
}
