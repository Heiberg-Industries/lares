// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

const actions=vi.hoisted(()=>({create:vi.fn(),issue:vi.fn(),preview:vi.fn(),status:vi.fn(),revoke:vi.fn()}));
vi.mock('../app/actions/private-metadata',()=>({
  createPrivateMetadataDataset:actions.create,issuePrivateMetadataDevice:actions.issue,
  previewPrivateMetadataTarget:actions.preview,privateMetadataDeviceStatus:actions.status,
  revokePrivateMetadataDevice:actions.revoke,
}));
import { PrivateMetadataDeviceSection } from '../components/PrivateMetadataDeviceSection';

const target={agentName:'helper',connectionName:'mac-private-metadata',descriptorFingerprint:'a'.repeat(64),tools:['lookup'],purpose:'read-only private metadata lookup'};
const status={accountId:'11111111-1111-4111-8111-111111111111',resourceBindingId:'22222222-2222-4222-8222-222222222222',
  datasetId:'member-dataset',accountGeneration:3,deviceId:'33333333-3333-4333-8333-333333333333',deviceGeneration:2,state:'active' as const};
beforeEach(()=>{vi.clearAllMocks();actions.preview.mockResolvedValue(target);actions.status.mockResolvedValue(status);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it('restores the member device status on revisit without returning either credential',async()=>{
  render(<PrivateMetadataDeviceSection/>);
  fireEvent.change(screen.getByLabelText('Agent name'),{target:{value:'helper'}});
  fireEvent.click(screen.getByText('Review current connection'));
  expect(await screen.findByText(/Device 33333333-3333-4333-8333-333333333333 is active/)).toBeTruthy();
  expect(screen.getByText('Private dataset created:')).toBeTruthy();
  expect(screen.getByText('member-dataset')).toBeTruthy();
  expect(screen.getByText('Replace device and issue upload credential')).toBeTruthy();
  expect(screen.queryByText('U'.repeat(43))).toBeNull();
  expect(JSON.stringify(actions.status.mock.results)).not.toContain('uploadToken');
});

it('shows the one-time upload token only after issuing a replacement and hides it after revisit',async()=>{
  actions.issue.mockResolvedValue({deviceId:status.deviceId,deviceGeneration:3,accountGeneration:3,uploadToken:'U'.repeat(43)});
  const view=render(<PrivateMetadataDeviceSection/>);
  fireEvent.change(screen.getByLabelText('Agent name'),{target:{value:'helper'}});
  fireEvent.click(screen.getByText('Review current connection'));
  await screen.findByText(/Device .* is active/);
  fireEvent.click(screen.getByLabelText(/I authorize this exact descriptor/));
  fireEvent.click(screen.getByText('Replace device and issue upload credential'));
  expect(await screen.findByText('U'.repeat(43))).toBeTruthy();
  expect(actions.issue).toHaveBeenCalledWith(expect.objectContaining({consent:true,accountId:status.accountId}));
  view.unmount();
  render(<PrivateMetadataDeviceSection/>);
  fireEvent.change(screen.getByLabelText('Agent name'),{target:{value:'helper'}});
  fireEvent.click(screen.getByText('Review current connection'));
  await waitFor(()=>expect(screen.getByText(/Device .* is active/)).toBeTruthy());
  expect(screen.queryByText('U'.repeat(43))).toBeNull();
});
