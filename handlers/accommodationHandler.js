const { db, admin } = require('../config/firebase');
const { validateAdminOrHead } = require('../middlewares/auth');
const { sendTemplateMessage } = require('../services/notificationService');

exports.updateAccommodationStatus = async (data, context) => {
  const user = await validateAdminOrHead(context);

  const { reqId, status } = data; // status: 'approved' | 'rejected' | 'recommended'

  if (!reqId || !['approved', 'rejected', 'recommended'].includes(status)) {
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

  // Double check the request belongs to people in the folks head group
  const targetUserDoc = await db.collection("users").doc(reqDoc.data().userId).get();
  if (user.role === 'folks_head' && targetUserDoc.data().assignedGroup !== user.uid) {
     throw new Error('Unauthorized to recommend accommodations outside your designated assigned group.');
  }

  await reqRef.update({
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Notify User via Gupshup WhatsApp template (business-initiated messages must use an approved template)
  const userId = reqDoc.data().userId;
  if(userId) {
     const userDoc = await db.collection("users").doc(userId).get();
     if(userDoc.exists && userDoc.data().phone) {
       const templateId = process.env.GUPSHUP_TEMPLATE_ACCOMMODATION_ID || 'accommodation_status_updated';
       await sendTemplateMessage(userDoc.data().phone, templateId, [status]);
     }
  }

  return { success: true };
};
