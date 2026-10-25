'use strict';
/*
 * Mission pool. Every mission has exactly 5 facts.
 *   truth = the real value (only the server and Double Agents know it)
 *   fake  = the plausible-looking value a forged report uses
 * All stories are fictional.
 *
 * To add your own mission: copy one block, keep exactly 5 facts,
 * and make each `fake` look believable but different from `truth`.
 */
function mission(id, title, story, facts) {
  return {
    id,
    title,
    story,
    facts: facts.map(([label, truth, fake], i) => ({ key: `f${i}`, label, truth, fake })),
  };
}

const MISSIONS = [
  mission('bluebird', 'Operation Bluebird',
    'A courier is carrying a sealed ledger across the harbor district tonight. Our team must confirm the handoff before we move.',
    [
      ['Courier', 'Marta Voss', 'Mara Voss'],
      ['Safehouse', 'Harbor Warehouse 9', 'Harbor Warehouse 3'],
      ['Time', '21:40', '21:04'],
      ['Codeword', 'Lantern', 'Compass'],
      ['Route', 'Tram Line 4', 'Tram Line 6'],
    ]),
  mission('nightingale', 'Operation Nightingale',
    'A defector will signal from a hotel window. We need the exact details before the extraction car leaves.',
    [
      ['Defector alias', 'Wren', 'Robin'],
      ['Hotel', 'Hotel Meridian', 'Hotel Marigold'],
      ['Room', '412', '214'],
      ['Signal', 'Two lamps lit', 'One lamp lit'],
      ['Pickup point', 'Rear loading dock', 'Side loading dock'],
    ]),
  mission('glass-orchard', 'Operation Glass Orchard',
    'An informant will meet us before sunrise inside a botanical garden. One wrong detail and they will not show.',
    [
      ['Informant', 'Dr. Ilse Kern', 'Dr. Ilse Kerr'],
      ['Meeting place', 'Greenhouse 5', 'Greenhouse 8'],
      ['Hour', '06:15', '06:50'],
      ['Password', 'Quince', 'Quartz'],
      ['Exit', 'North gate', 'South gate'],
    ]),
  mission('silent-ferry', 'Operation Silent Ferry',
    'A night ferry will carry something that must never reach the far shore. Pin down the vessel before it sails.',
    [
      ['Vessel', 'MV Calypso', 'MV Calista'],
      ['Departure', '23:20', '22:20'],
      ['Pier', 'Pier 14', 'Pier 41'],
      ['Cargo', 'Film reels', 'Radio parts'],
      ['Contact', 'Captain Osei', 'Captain Okoye'],
    ]),
  mission('cold-archive', 'Operation Cold Archive',
    'A forgotten archive holds one ledger that proves who is selling our secrets. We get a single window to get in.',
    [
      ['Vault', 'Vault C-17', 'Vault C-71'],
      ['Guard shift', 'Night shift', 'Day shift'],
      ['File', 'Ledger 1182', 'Ledger 1128'],
      ['Door code', '7 3 9 1', '7 3 1 9'],
      ['Entrance', 'Freight elevator', 'Service stairwell'],
    ]),
  mission('velvet-static', 'Operation Velvet Static',
    'An unlicensed radio station is broadcasting coded messages. We must identify the station before it goes dark.',
    [
      ['Station', 'Radio tower Delta', 'Radio tower Dalton'],
      ['Frequency', '88.4 MHz', '84.8 MHz'],
      ['Operator', 'Joss Hart', 'Josh Hart'],
      ['Broadcast time', '02:30', '03:20'],
      ['Phrase', 'The owl is home', 'The owl is away'],
    ]),
  mission('amber-crossing', 'Operation Amber Crossing',
    'A source needs to cross the border unseen. The smallest mismatch in the plan will get them stopped.',
    [
      ['Border post', 'Checkpoint Nine', 'Checkpoint Five'],
      ['Vehicle', 'Grey delivery van', 'Blue delivery van'],
      ['Plate', 'KR-4419', 'KR-4491'],
      ['Escort', 'Agent Pell', 'Agent Bell'],
      ['Window', 'Dawn', 'Dusk'],
    ]),
  mission('midnight-gallery', 'Operation Midnight Gallery',
    'A stolen painting hides microfilm. The handover happens after the museum closes, and we must know exactly where.',
    [
      ['Painting', 'The Salt Garden', 'The Sand Garden'],
      ['Curator', 'Ines Marlow', 'Iris Marlow'],
      ['Room', 'East wing', 'West wing'],
      ['Badge', 'Blue badge', 'Red badge'],
      ['Time', '20:45', '20:15'],
    ]),
  mission('harbor-lights', 'Operation Harbor Lights',
    'A smuggling ring is moving a crate under cover of the evening fog. Get the details right and we can shut it down.',
    [
      ['Smuggler', 'Tomas Brandt', 'Tomas Grant'],
      ['Dock', 'Dock 6', 'Dock 9'],
      ['Crate', 'Crate marked K', 'Crate marked R'],
      ['Lookout', 'Crane operator', 'Harbor master'],
      ['Signal', 'Green flare', 'Red flare'],
    ]),
];

module.exports = { MISSIONS };
