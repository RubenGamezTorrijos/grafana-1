import { VisualizationSuggestionsBuilder } from '@grafana/data';
import { config } from '@grafana/runtime';
import { prepareHeatmapData } from './fields';
import { PanelOptions, defaultPanelOptions } from './models.gen';

export class HeatmapSuggestionsSupplier {
  getSuggestionsForData(builder: VisualizationSuggestionsBuilder) {
    const { dataSummary } = builder;

    if (
      !builder.data?.series ||
      !dataSummary.hasData ||
      dataSummary.timeFieldCount < 1 ||
      dataSummary.numberFieldCount < 2 ||
      dataSummary.numberFieldCount > 10
    ) {
      return;
    }

    const info = prepareHeatmapData({ heatmap: builder.data.series }, defaultPanelOptions, config.theme2);
    if (!info || info.warning) {
      return;
    }

    builder.getListAppender<PanelOptions, {}>({
      name: '',
      pluginId: 'heatmap-new',
      options: {},
      fieldConfig: {
        defaults: {
          custom: {},
        },
        overrides: [],
      },
    });
  }
}
