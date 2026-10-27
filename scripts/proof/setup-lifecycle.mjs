// Persist intent BEFORE each mutation so an interrupted operation remains
// recoverable. These operations never request or handle passkey credentials.
export async function applySetup({ state, existingMapping, persist, trust, verifyTrust, hosts, verifyHosts }) {
  if (state.trustAttempted || state.hostsAttempted) throw new Error('Instalação já iniciada; diagnostique ou remova antes de repetir.');
  state.trustAttempted = true;
  await persist(state);
  await trust();
  await verifyTrust();
  if (!existingMapping) {
    state.hostsAttempted = true;
    await persist(state);
    await hosts();
  }
  await verifyHosts();
  state.installed = true;
  await persist(state);
}

// Resume only the known interruption after trust verification and before the
// privileged hosts helper completed. Recheck existing trust; never reinstall it.
export async function resumeHostsSetup({ state, persist, verifyTrust, hosts, verifyHosts }) {
  if (state.installed || !state.trustAttempted || !state.hostsAttempted) throw new Error('Estado não corresponde a uma instalação interrompida em hosts.');
  await verifyTrust();
  await hosts();
  await verifyHosts();
  state.installed = true;
  await persist(state);
}
