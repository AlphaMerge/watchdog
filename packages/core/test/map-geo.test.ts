import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readCoordinate, readGeoView } from '../src/maps/geo.js';

/**
 * Reading the geographical half of a document nobody has to have written correctly (`G-08`).
 *
 * `map.layout` is `jsonb` an API caller wrote, so these two functions are the whole boundary
 * between "what somebody saved" and "where a wall display points". What is asserted here is the
 * refusal side of that: which documents come back as a plain canvas rather than as a map opening
 * somewhere real and wrong.
 */

describe("a map's home view", () => {
  it('reads the view an author saved', () => {
    assert.deepEqual(readGeoView({ geo: { lat: 52.52, lon: 13.405, zoom: 6 } }), {
      lat: 52.52,
      lon: 13.405,
      zoom: 6,
      publicTiles: false,
    });
  });

  it('is absent for a document that is not geographical', () => {
    assert.equal(readGeoView({ widgets: [] }), null);
    assert.equal(readGeoView(null), null);
    assert.equal(readGeoView('a map'), null);
    assert.equal(readGeoView({ geo: 'somewhere' }), null);
    assert.equal(readGeoView([{ geo: { lat: 0, lon: 0 } }]), null);
  });

  it('refuses a geo block with no centre, rather than opening in the Gulf of Guinea', () => {
    // Defaulting a missing centre to 0,0 puts an unconfigured map off the coast of Africa, which
    // is a bug people have shipped and which looks like a deliberate choice of place.
    assert.equal(readGeoView({ geo: { zoom: 6 } }), null);
    assert.equal(readGeoView({ geo: { lat: 52.52, zoom: 6 } }), null);
    assert.equal(readGeoView({ geo: { lat: '52.52', lon: '13.4' } }), null);
    assert.equal(readGeoView({ geo: { lat: Number.NaN, lon: 0 } }), null);
  });

  it("refuses a centre out of range, the same as a widget's own coordinate", () => {
    // 200° north is a typo. Clamping it to the edge of the Mercator world would open the map at
    // the pole, which reads as somebody's decision — and it would disagree with the designer,
    // which treats the same document as a plain canvas.
    assert.equal(readGeoView({ geo: { lat: 200, lon: 0 } }), null);
    assert.equal(readGeoView({ geo: { lat: 0, lon: -400 } }), null);
  });

  it('clamps the zoom, because a scale is not a place', () => {
    // Unlike the centre: every renderer clamps zoom to the tile scheme anyway, and a map that
    // opens too far in is still that map rather than a different one.
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0, zoom: 99 } })?.zoom, 19);
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0, zoom: -4 } })?.zoom, 0);
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0, zoom: 6.6 } })?.zoom, 7);
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0 } })?.zoom, 3);
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0, zoom: 'far' } })?.zoom, 3);
  });

  it('keeps public tiles off unless the document says the word', () => {
    // `ADR-004` Decision 4 is an opt-in, so anything that is not `true` is off — including the
    // truthy strings and numbers a hand-written document arrives with.
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0, publicTiles: true } })?.publicTiles, true);
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0 } })?.publicTiles, false);
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0, publicTiles: 'yes' } })?.publicTiles, false);
    assert.equal(readGeoView({ geo: { lat: 0, lon: 0, publicTiles: 1 } })?.publicTiles, false);
  });
});

describe("a widget's coordinate", () => {
  it('reads one', () => {
    assert.deepEqual(readCoordinate({ lat: -33.87, lon: 151.21 }), { lat: -33.87, lon: 151.21 });
    assert.deepEqual(readCoordinate({ lat: 0, lon: 0 }), { lat: 0, lon: 0 });
  });

  it('is absent for a widget positioned by its box', () => {
    assert.equal(readCoordinate(undefined), null);
    assert.equal(readCoordinate(null), null);
    assert.equal(readCoordinate({}), null);
    assert.equal(readCoordinate({ lat: 52 }), null);
    assert.equal(readCoordinate([52, 13]), null);
  });

  it('refuses a coordinate that is not one, rather than putting the widget in the Pacific', () => {
    assert.equal(readCoordinate({ lat: 91, lon: 0 }), null);
    assert.equal(readCoordinate({ lat: -91, lon: 0 }), null);
    assert.equal(readCoordinate({ lat: 0, lon: 181 }), null);
    assert.equal(readCoordinate({ lat: 0, lon: -181 }), null);
    assert.equal(readCoordinate({ lat: Number.POSITIVE_INFINITY, lon: 0 }), null);
  });

  it('keeps the ends of the ranges, which are places', () => {
    // The poles and the antimeridian are coordinates; the projection is what has to cope with
    // them, not this reader.
    assert.deepEqual(readCoordinate({ lat: 90, lon: 180 }), { lat: 90, lon: 180 });
    assert.deepEqual(readCoordinate({ lat: -90, lon: -180 }), { lat: -90, lon: -180 });
  });
});
