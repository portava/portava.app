"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTravelBuddyVerified = isTravelBuddyVerified;
exports.getVerificationLabel = getVerificationLabel;
exports.getVerificationOwnerPrompt = getVerificationOwnerPrompt;
function isTravelBuddyVerified(profile) {
    if (!profile)
        return false;
    if (profile.verificationStatus === 'verified')
        return true;
    if (profile.verificationStatus == null && profile.verified === true)
        return true;
    return false;
}
function getVerificationLabel(status) {
    switch (status) {
        case 'verified': return 'Travel Buddy Verified';
        case 'pending': return 'Verification pending';
        case 'rejected': return 'Verification needs attention';
        case 'expired': return 'Verification expired';
        default: return 'Not verified';
    }
}
function getVerificationOwnerPrompt(status) {
    switch (status) {
        case 'verified': return null;
        case 'pending': return 'Verification pending';
        case 'rejected': return 'Verification needs attention';
        case 'expired': return 'Verification expired';
        default: return 'Verify your Passport';
    }
}
