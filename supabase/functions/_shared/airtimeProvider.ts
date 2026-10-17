/**
 * Airtime Provider Integration for Skaitech Ghana
 * Provider: Hubtel Prepaid Airtime API
 */

import { getHubtelAuthorizationHeader } from './hubtelAuth.ts';
import { hubtelRequest } from './hubtelClient.ts';

export interface AirtimeDispatchResult {
  success: boolean;
  status: 'delivered' | 'failed' | 'pending_provider';
  providerReference?: string;
  providerResponse?: Record<string, unknown>;
  failureReason?: string;
}

export async function dispatchAirtimeTopup(params: {
  phone: string;
  network: 'mtn' | 'telecel' | 'at';
  amount: number;
  reference: string;
}): Promise<AirtimeDispatchResult> {
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID');
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET');
  const accountNumber = Deno.env.get('HUBTEL_MERCHANT_ACCOUNT_NUMBER');

  // Guard: If Hubtel credentials are not configured, do not fake success!
  if (!clientId || !clientSecret || !accountNumber) {
    console.warn('Hubtel API credentials are not configured. Order queued as pending_provider.');
    return {
      success: false,
      status: 'pending_provider',
      failureReason: 'Airtime provider API credentials are not yet configured.',
      providerResponse: {
        notice: 'Awaiting Hubtel configuration in Supabase secrets (HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET, HUBTEL_MERCHANT_ACCOUNT_NUMBER)',
      }
    };
  }

  // Format phone number to standard Ghana MSISDN: 233XXXXXXXXX
  const cleanPhone = params.phone.replace(/\D/g, '');
  const msisdn = cleanPhone.startsWith('0') ? '233' + cleanPhone.slice(1) : cleanPhone;

  // Map network to Hubtel channels
  const channelMap: Record<string, string> = {
    mtn: 'mtn-gh',
    telecel: 'vodafone-gh', // Hubtel channel ID for Telecel (formerly Vodafone Ghana)
    at: 'tigo-gh',          // Hubtel channel ID for AT (formerly AirtelTigo)
  };

  const channel = channelMap[params.network] || `${params.network}-gh`;

  try {
    const endpoint = `https://api.hubtel.com/v1/merchantaccount/merchants/${encodeURIComponent(accountNumber)}/prepaid/topup`;

    const body: Record<string, unknown> = {
      CustomerMsisdn: msisdn,
      Channel: channel,
      Amount: params.amount,
      ClientReference: params.reference,
      Description: `Skaitech Airtime Topup - ${params.network.toUpperCase()}`,
    };
    const senderId = Deno.env.get('HUBTEL_SENDER_ID')?.trim();
    if (senderId) body.SenderId = senderId;

    const response = await hubtelRequest(endpoint, {
      method: 'POST',
      body,
      authorization: await getHubtelAuthorizationHeader(),
    });

    const responseData = response.payload;
    const responseCode = String(responseData.ResponseCode ?? responseData.responseCode ?? '');
    const isSuccess = response.ok && (
      responseCode === '0000' ||
      responseData.Status === 'Success' ||
      responseData.status === 'success'
    );

    if (isSuccess) {
      return {
        success: true,
        status: 'delivered',
        providerReference: String(
          responseData.TransactionId ??
          responseData.transactionId ??
          responseData.Data?.TransactionId ??
          params.reference
        ),
        providerResponse: responseData,
      };
    } else {
      return {
        success: false,
        status: 'failed',
        failureReason: responseData.Message || responseData.message || responseData.Description || 'Hubtel top-up request was declined.',
        providerResponse: responseData,
      };
    }
  } catch (err) {
    console.error('Hubtel API dispatch error:', err);
    return {
      success: false,
      status: 'failed',
      failureReason: err instanceof Error ? err.message : 'Network error connecting to Hubtel airtime provider.',
      providerResponse: { error: String(err) }
    };
  }
}
