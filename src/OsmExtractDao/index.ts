// TODO: Should verify that GPKG's modified timestamp > PBF's.

// For possible extract formats and styles see https://extract.bbbike.org/extract-screenshots.html

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import gdal, { Dataset } from 'gdal-next';
import * as turf from '@turf/turf';

import osmDir from '../constants/osmDataDir';
import osmBoundaryAdministrationLevelCodes from '../constants/osmBoundaryAdministrationLevelCodes';

import isValidExtractAreaName from '../utils/isValidExtractAreaName';
import isValidOsmVersionExtractName from '../utils/isValidOsmVersionExtractName';
import getOsmosisExtractFilter from '../utils/getOsmosisExtractFilter';

import { AdministrationLevel, AdministrationAreaName } from '../domain/types';

gdal.verbose();

export type OsmMultipolygonQueryObj = Record<string, string | number>;

const osmosisExecutable = join(
  __dirname,
  '../../lib/osmosis/osmosis-0.48.3/bin/osmosis',
);

export default class OsmExtractDao {
  static getExtractDirectoryPath(extractName: string) {
    return join(osmDir, extractName);
  }

  static getCleanedExtractAreaName(extractAreaName: string) {
    return extractAreaName
      .replace(/[^a-z0-9_-]{1,}/g, '-')
      .replace(/-{1,}/, '-');
  }

  static getAdministrativeAreaExtractNamePrefix(
    adminLevel: AdministrationLevel,
    name: string,
  ) {
    let n = name.toLowerCase();

    if (n.endsWith(adminLevel)) {
      n = n.replace(new RegExp(`${adminLevel}$`, 'i'), '');
    }

    n = OsmExtractDao.getCleanedExtractAreaName(`${n}-${adminLevel}`);

    return n;
  }

  readonly osmVersionExtractName: string;
  readonly osmVersionExtractDir: string;
  readonly pbfFileName: string;
  readonly gpkgFileName: string;
  readonly pbfFilePath: string;
  readonly gpkgFilePath: string;
  protected _pbfDataset: Dataset | null;
  protected _gpkgDataset: Dataset | null;

  constructor(osmVersionExtractName: string) {
    // ABSOLUTELY MUST sanitize because used in execSync below.
    if (!isValidOsmVersionExtractName(osmVersionExtractName)) {
      throw new Error(
        `Invalid osmVersionExtractName: ${osmVersionExtractName}`,
      );
    }

    this.osmVersionExtractName = osmVersionExtractName;
    this.osmVersionExtractDir = OsmExtractDao.getExtractDirectoryPath(
      this.osmVersionExtractName,
    );

    if (!existsSync(this.osmVersionExtractDir)) {
      throw new Error(
        `Error directory ${this.osmVersionExtractDir} does not exist.`,
      );
    }

    this.pbfFileName = join(`${this.osmVersionExtractName}.osm.pbf`);
    this.gpkgFileName = join(`${this.osmVersionExtractName}.osm.gpkg`);

    this.pbfFilePath = join(
      this.osmVersionExtractDir,
      `${this.osmVersionExtractName}.osm.pbf`,
    );

    this.gpkgFilePath = join(
      this.osmVersionExtractDir,
      `${this.osmVersionExtractName}.osm.gpkg`,
    );

    this._pbfDataset = null;
    this._gpkgDataset = null;
  }

  protected get pbfDataset() {
    this._pbfDataset =
      this._pbfDataset || gdal.open(this.pbfFilePath, 'r', 'OSM');
    return this._pbfDataset;
  }

  protected get gpkgExists() {
    return existsSync(this.gpkgFilePath);
  }

  // Because executeSQL fails with "Too many features have accumulated in points layer" error,
  //   we create a GPKG so we can get administrative boundaries with executeSQL.
  // See https://gdal.org/drivers/vector/osm.html#interleaved-reading
  createGPKG() {
    if (this.gpkgExists) {
      throw new Error('GPKG already exists.');
    }

    console.log('creating GPKG');

    // Using ogr2ogr to create the GPKG because doing everything in node-gdal
    //   is more complicated and error prone. Also, eventual FileGDB support important.
    const command = `ogr2ogr -F GPKG ${this.gpkgFileName} ${this.pbfFileName}`;

    // NOTE: spawnSync preferred, but it created empty GPKGs. Don't know why.
    execSync(command, { cwd: this.osmVersionExtractDir });

    // Make the GPKG readonly.
    chmodSync(this.gpkgFilePath, '444');
  }

  protected get gpkgDataset() {
    if (!this.gpkgExists) {
      this.createGPKG();
    }

    this._gpkgDataset =
      this._gpkgDataset || gdal.open(this.gpkgFilePath, 'r', 'GPKG');
    return this._gpkgDataset;
  }

  get layers() {
    return this.gpkgDataset.layers.map((l) => l.name);
  }

  getMultiPolygon(query: OsmMultipolygonQueryObj) {
    try {
      const whereClause = Object.keys(query)
        .map((k) => `( ${k} = '${query[k]}' )`)
        .join(' AND ');

      const sql = `
        SELECT
            *
          FROM multipolygons
          WHERE ( ${whereClause} )
      `;

      console.log(sql);

      // NOTE: This could be replaced with call to ogr2ogr -f GeoJSON ....
      //       Which would allow us to use node-gdal rather than node-gdal-next.
      const result = this.gpkgDataset.executeSQL(sql, undefined, 'SQLITE');

      if (result.features.count(true) === 0) {
        throw new Error('No results');
      }

      if (result.features.count(true) > 1) {
        throw new Error('More than 1 result');
      }

      const feature = result.features.first();

      const properties = feature.fields.toObject();

      // @ts-ignore
      const { coordinates } = feature.getGeometry().toObject();

      // @ts-ignore
      const multiPolygon = turf.multiPolygon(coordinates, properties);

      return multiPolygon;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  getOsmosisFilterPoly(extractName: string, query: OsmMultipolygonQueryObj) {
    const geojsonPoly = this.getMultiPolygon(query);

    if (geojsonPoly === null) {
      throw new Error('Unable to create MultiPolygon');
    }

    const polyfileData = getOsmosisExtractFilter(geojsonPoly, extractName);

    return polyfileData;
  }

  createExtract(extractName: string, query: OsmMultipolygonQueryObj) {
    console.log(extractName);
    if (!isValidOsmVersionExtractName(extractName)) {
      throw new Error(`Invalid osmVersionExtractName: ${extractName}`);
    }

    const extractDirPath = OsmExtractDao.getExtractDirectoryPath(extractName);

    if (existsSync(extractDirPath)) {
      throw new Error(
        `OSM Version Extract directory already exists at ${extractDirPath}`,
      );
    }

    mkdirSync(extractDirPath, { recursive: true });

    const poly = this.getOsmosisFilterPoly(extractName, query);
    const polyFilePath = join(extractDirPath, `${extractName}.poly`);

    writeFileSync(polyFilePath, poly);

    const extractPbfFilePath = join(extractDirPath, `${extractName}.osm.pbf`);

    const command = `${osmosisExecutable} \
      --read-pbf-fast file=${this.pbfFilePath} \
      --sort type="TypeThenId" \
      --bounding-polygon \
          file=${polyFilePath} \
          completeWays=yes \
      --write-pbf ${extractPbfFilePath}
    `;

    execSync(command);

    execSync(`xz -9 ${polyFilePath}`);
  }

  getMultiPolygonQueryForAdminRegion(
    adminLevel: AdministrationLevel,
    name: AdministrationAreaName,
  ) {
    return {
      type: 'boundary',
      boundary: 'administrative',
      admin_level: osmBoundaryAdministrationLevelCodes[adminLevel],
      name,
    };
  }

  getExtractName(extractAreaName: string) {
    if (!isValidExtractAreaName(extractAreaName)) {
      throw new Error(`Invalid extractAreaName: ${extractAreaName}`);
    }

    const extractName = `${extractAreaName}_${this.osmVersionExtractName}`;

    return extractName;
  }

  // NOTE: '_' reserved as separator between admistraction area extraction layers
  //       So we could have town-of-berne_albany-county_new-york-state_us-northeast-region_planet-210101
  //         if we create the OSM version extract as follows:
  //           1. Download us-northeast-210101.osm.pbf from GEOFABRIK as us-northeast-region_planet-210101
  //           2. Extract new-york-state from us-northeast-region_planet-210101
  //           3. Extract albany-county from new-york-state_us-northeast-region_planet-210101
  //           4. Extract town-of-berne from albany-county_new-york-state_us-northeast-region_planet-210101.
  //
  //       Thus preserving the OSM Version Extract's lineage in its name.
  getAdministrativeAreaExtractName(
    adminLevel: AdministrationLevel,
    name: AdministrationAreaName,
  ) {
    const cleanedName = OsmExtractDao.getAdministrativeAreaExtractNamePrefix(
      adminLevel,
      name,
    );

    const extractName = `${cleanedName}_${this.osmVersionExtractName}`;

    return extractName;
  }

  getAdministrativeBoundaryMultiPolygon(
    adminLevel: AdministrationLevel,
    name: AdministrationAreaName,
  ) {
    const q = this.getMultiPolygonQueryForAdminRegion(adminLevel, name);

    return this.getMultiPolygon(q);
  }

  getAdministrativeBoundaryOsmosisFilterPoly(
    adminLevel: AdministrationLevel,
    name: AdministrationAreaName,
  ) {
    const extractName = this.getAdministrativeAreaExtractName(adminLevel, name);

    const q = this.getMultiPolygonQueryForAdminRegion(adminLevel, name);

    return this.getOsmosisFilterPoly(extractName, q);
  }

  createAdministrativeRegionExtract(
    adminLevel: AdministrationLevel,
    name: AdministrationAreaName,
  ) {
    const extractName = this.getAdministrativeAreaExtractName(adminLevel, name);

    const q = this.getMultiPolygonQueryForAdminRegion(adminLevel, name);

    this.createExtract(extractName, q);
  }

  get vrtFileName() {
    return `${this.osmVersionExtractName}.vrt`;
  }

  get vrtFilePath() {
    return join(this.osmVersionExtractDir, this.vrtFileName);
  }

  // https://gdal.org/drivers/vector/vrt.html
  // https://gis.stackexchange.com/a/79179
  createVRTFile() {
    // NOTE: SrcSQL could be used to create thematic layers.
    const vrt = `<OGRVRTDataSource>
    <OGRVRTUnionLayer name="${this.osmVersionExtractName}">
        <OGRVRTLayer name="points">
            <SrcDataSource>${this.pbfFileName}</SrcDataSource>
            <SrcLayer>points</SrcLayer>
        </OGRVRTLayer>
        <OGRVRTLayer name="lines">
            <SrcDataSource>${this.pbfFileName}</SrcDataSource>
            <SrcLayer>lines</SrcLayer>
        </OGRVRTLayer>
        <OGRVRTLayer name="multilinestrings">
            <SrcDataSource>${this.pbfFileName}</SrcDataSource>
            <SrcLayer>multilinestrings</SrcLayer>
        </OGRVRTLayer>
        <OGRVRTLayer name="multipolygons">
            <SrcDataSource>${this.pbfFileName}</SrcDataSource>
            <SrcLayer>multipolygons</SrcLayer>
        </OGRVRTLayer>
        <GeometryType>wkbGeometryCollection</GeometryType>
    </OGRVRTUnionLayer>
</OGRVRTDataSource>`;

    writeFileSync(this.vrtFilePath, vrt);
  }

  // FIXME: Should use an improved VRT file that has thematic layers.
  //       See:
  //            * https://wiki.openstreetmap.org/wiki/Shapefiles
  //            * https://osmdata.openstreetmap.de/processing/software.html
  //              * https://github.com/fossgis/osmdata/
  //            * https://wiki.openstreetmap.org/wiki/User:Bgirardot/How_To_Convert_osm_.pbf_files_to_Esri_Shapefiles
  createShapefile() {
    const shapefileParentDir = join(
      this.osmVersionExtractDir,
      'ESRI_Shapefile',
    );
    // const shapefilePath = join(shapefileParentDir, this.osmVersionExtractName);
    const shapefilePath = join(shapefileParentDir, this.osmVersionExtractName);

    if (existsSync(shapefilePath)) {
      throw new Error(`${shapefilePath} already exists.`);
    }

    mkdirSync(shapefileParentDir, { recursive: true });

    execSync(`ogr2ogr \
      -skipfailures \
      -f 'ESRI Shapefile' \
      '${shapefilePath}' \
      '${this.pbfFilePath}' points \
      -nlt POINT
    `);

    execSync(`ogr2ogr \
      -append \
      -f 'ESRI Shapefile' \
      '${shapefilePath}' \
      '${this.pbfFilePath}' lines \
      -nlt LINESTRING
    `);

    execSync(`ogr2ogr \
      -append \
      -f 'ESRI Shapefile' \
      '${shapefilePath}' \
      '${this.pbfFilePath}' multilinestrings \
      -nlt MULTILINESTRING
    `);

    execSync(`ogr2ogr \
      -append \
      -f 'ESRI Shapefile' \
      '${shapefilePath}' \
      '${this.pbfFilePath}' multipolygons \
      -nlt MULTIPOLYGON
    `);

    /*
       // FIXME: This Breaks.
    execSync(`ogr2ogr \
      -append \
      -skipfailures \
      -f 'ESRI Shapefile' \
      '${shapefilePath}' \
      '${this.pbfFilePath}' other_relations \
    `);
    */
  }

  createXml() {
    const xmlFileName = `${this.osmVersionExtractName}.osm`;
    const xmlPath = join(this.osmVersionExtractDir, xmlFileName);

    const command = `${osmosisExecutable} \
      --read-pbf-fast file=${this.pbfFilePath} \
      --sort type="TypeThenId" \
      --write-xml ${xmlPath}
    `;

    execSync(command);
  }

  createGeoJSON() {
    const geoJsonFileName = `${this.osmVersionExtractName}.osm.geojson`;

    this.createVRTFile();

    execSync(
      `ogr2ogr \
      -skipfailures \
      -f 'GeoJSON' \
      '${geoJsonFileName}' \
      '${this.vrtFileName}'
    `,
      { cwd: this.osmVersionExtractDir },
    );
  }
}
