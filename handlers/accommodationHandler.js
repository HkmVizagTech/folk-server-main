const { db, admin } = require('../config/firebase');
const { validateAdminOrHead } = require('../middlewares/auth');
const { sendTemplateMessage } = require('../services/notificationService');

exports.updateAccommodationStatus = async (data, context) => {
  const user = await validateAdminOrHead(context);

  const { reqId, status } = data || {}; // status: 'approved' | 'rejected' | 'recommended'

  if (typeof reqId !== 'string' || !reqId || reqId.includes('/') || !['approved', 'rejected', 'recommended'].includes(status)) {
    throw new Error('Invalid or missing parameters');
  }

  // folks_head can only 'recommend', main admins hold the keys to approve/reject
  if (user.role === 'folks_head' && status !== 'recommended') {
    throw new Error('Folks Heads can only recommend accommodation requests.');
  }

  const reqRef = db.collection("accommodation_requests").doc(reqId);
  const reqDoc = await reqRef.get();
  
  if (!reqDoc.exists) {
    throw new Error('Accommodation request does not exist');
  }

  const userId = reqDoc.data().userId;
  const targetUserDoc = userId ? await db.collection("users").doc(String(userId)).get() : null;
  const targetUser = targetUserDoc && targetUserDoc.exists ? targetUserDoc.data() : null;

  // Double check the request belongs to people in the folks head group. A
  // request whose devotee has no profile (deleted, or never created) used to
  // crash here with a TypeError; now a folks_head simply can't act on it.
  if (user.role === 'folks_head' && (!targetUser || targetUser.assignedGroup !== user.uid)) {
     throw new Error('Unauthorized to recommend accommodations outside your designated assigned group.');
  }

  await reqRef.update({
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Notify User via Gupshup WhatsApp template (business-initiated messages must use an approved template).
  // The status is already saved, so a messaging failure must not fail the request.
  if (targetUser && targetUser.phone) {
    const templateId = process.env.GUPSHUP_TEMPLATE_ACCOMMODATION_ID || 'accommodation_status_updated';
    await sendTemplateMessage(targetUser.phone, templateId, [status]).catch((error) => {
      console.error('Accommodation notification failed:', error);
    });
  }

  return { success: true };
};
