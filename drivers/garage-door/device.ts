
import axios from 'axios';
import Homey from 'homey';
import { OGState, OGCommand, OGResponse } from './definations';

class GarageDoorDevice extends Homey.Device {

	/* Since we dont use "constructor" but oninit these fails. */
	/* adding ! tells typescript to trust me, i'm gonna init them */

	/* Triggers */
	private doorOpenTrigger!: Homey.FlowCardTriggerDevice;
	private doorCloseTrigger!: Homey.FlowCardTriggerDevice;
	private carStateChangeTrigger!: Homey.FlowCardTriggerDevice;

	/* Actions */
	private doorCloseAction!: Homey.FlowCardAction;
	private doorOpenAction!: Homey.FlowCardAction;

	/* Conditions */
	private isOpenCondition!: Homey.FlowCardCondition;
	private carIsPresentCondition!: Homey.FlowCardCondition;
	private heightIsCondition!: Homey.FlowCardCondition;

	private debounceActive: boolean = false;
	private pollTimer!: NodeJS.Timeout;
	private isPolling: boolean = false;

	async onInit() {

		/* Migration */
		if (this.hasCapability('garagedoor_closed') === false) {
			this.log(`Adding new garagedoor_closed capability to ${this.getName()}`);
			await this.addCapability('garagedoor_closed');
		}
		if (this.getClass() !== 'garagedoor') {
			this.log(`Changing class on ${this.getName()} from ${this.getClass()} to garagedoor`);
			await this.setClass('garagedoor');
		};

		/* Deprecation */
		if (this.hasCapability('door_state')) {
			this.log(`Removing old door_state capability from ${this.getName()}`);
			await this.removeCapability('door_state');
		}

		/* Define cards */
		this.doorOpenTrigger = this.homey.flow.getDeviceTriggerCard('door_open');
		this.doorCloseTrigger = this.homey.flow.getDeviceTriggerCard('door_close');
		this.carStateChangeTrigger = this.homey.flow.getDeviceTriggerCard('vehicle_state_change');
		this.doorCloseAction = this.homey.flow.getActionCard('door_close');
		this.doorOpenAction = this.homey.flow.getActionCard('door_open');
		this.isOpenCondition = this.homey.flow.getConditionCard('is_open');
		this.carIsPresentCondition = this.homey.flow.getConditionCard('vehicle_is_present');
		this.heightIsCondition = this.homey.flow.getConditionCard('height_is');

		/* Actions */
		this.doorCloseAction.registerRunListener(async ({ device }) => { device.sendDoorCommand(OGCommand.close); });
		this.doorOpenAction.registerRunListener(async ({ device }) => { device.sendDoorCommand(OGCommand.open); });

		/* Conditions */
		this.isOpenCondition.registerRunListener(async ({ device }) => !device.getCapabilityValue("garagedoor_closed"));
		this.carIsPresentCondition.registerRunListener(({ device }) => device.getCapabilityValue("vehicle_state") == '1');
		this.heightIsCondition.registerRunListener(async ({ height, device }) => device.getCapabilityValue("measure_distance") > height);

		/* Capabilities */
		this.registerCapabilityListener('garagedoor_closed', this.changeDoorState.bind(this));

		/* Start polling data */
		this.log(`Starting timer for device: ${this.getName()}`);
		this.pollData();
	}

	createEndpoint(path: string): string {

		const settings = this.getSettings();
		return `http://${settings.ip}:${settings.port}/${path}`;
	}

	sendDoorCommand(command: OGCommand): Promise<void> {

		this.log(`Sending door command ${command} for ${this.getName()}`);

		return new Promise(async (resolve, reject) => {
			try {
				const endpoint = this.createEndpoint(`cc?dkey=${this.getSetting('deviceKey')}&${command}=1`);
				const res = await axios.get(endpoint);
				const response: OGResponse = res.data;

				if (response.result == 1) {

					// Stop the poll timer, we know something is moving and we can wait 
					// until the openCloseTime to poll again.
					clearTimeout(this.pollTimer);
					this.pollTimer = setTimeout(() => { this.pollData() }, this.getSetting('openCloseTime') * 1000);

					// Done!
					resolve();
				} else {

					reject(response.result);
				}
			} catch (error) {

				reject(error);
			}
		})
	}

	changeDoorState(toClosed: boolean): Promise<void> {

		return new Promise(async (resolve, reject) => {

			if (this.debounceActive) {
				reject(this.homey.__("errors.debounce"));
			} else {
				try {

					// Send door command
					await this.sendDoorCommand(toClosed ? OGCommand.close : OGCommand.open);

					// Activate debounce
					this.debounceActive = true;
					setTimeout(() => { this.debounceActive = false; }, 1000);

					// DEPRECATED: Also trigger deprecrated flows
					this.triggerDeprecatedOpenCloseFlow(toClosed);

					// Resolve
					resolve();
				} catch (error) {

					reject(this.homey.__("errors.error_when_changing_door_state", { error }));
				}
			}
		})

	}

	pollData(): void {

		if (this.isPolling) return;
		this.isPolling = true;

		axios.get(this.createEndpoint('jc'))
			.then(response => {
				this.parseData(response.data as OGState);
				if (!this.getAvailable()) { this.setAvailable(); }
			})
			.catch((error) => {
				this.log(`Error polling data from device ${this.getName()}. Error given: ${error.code} (${error.errno})`);
				this.setUnavailable(this.homey.__("errors.polling", { error: error.code }));
			})
			.finally(() => {
				this.isPolling = false;
				this.pollTimer = setTimeout(() => { this.pollData() }, this.getSetting('pollingRate') * 1000);
			})
	}

	parseData(data: OGState) {

		/* Update lastData */
		const isDoorClosed = data.door == 0;

		/* This should only be different if changed by external means. */
		if (this.getCapabilityValue("garagedoor_closed") != isDoorClosed) {

			/* It has changed! Lets update the state of garagedoor_closed */
			this.setCapabilityValue("garagedoor_closed", isDoorClosed);

			// DEPRECATED: Also trigger deprecrated flows
			this.triggerDeprecatedOpenCloseFlow(isDoorClosed);
		}

		/* Update distance if change is detected */
		if (this.getCapabilityValue("measure_distance") != data.dist) {

			this.setCapabilityValue("measure_distance", data.dist);
		}

		/* Update vehicle state if state is changed */ 
		if (this.getCapabilityValue("vehicle_state") != data.vehicle.toString()) {

			this.setCapabilityValue("vehicle_state", data.vehicle.toString())
			this.carStateChangeTrigger
				.trigger(this)
				.then(() => this.log("Trigger vehicle change"))
				.catch((err) => this.error(`Trigger vehicle change failed: ${err}`))
		}

		/* Update RSSI if changed */
		if (this.getCapabilityValue("measure_rssi") != data.rssi) {

			this.setCapabilityValue("measure_rssi", data.rssi)
		}
	}

	// This is just to keep backwards compability.
	triggerDeprecatedOpenCloseFlow(didDoorJustClose: boolean) {
		
		// DEPRECATED: Also trigger deprecrated flows
		(didDoorJustClose ? this.doorCloseTrigger : this.doorOpenTrigger)
		.trigger(this)
		.then(() => this.log(`DEPRECATED: Trigger door change to: isDoorClosed=${didDoorJustClose}`))
		.catch((err) => this.error(`DEPRECATED: Trigger door change failed: ${err}`));

	}
}

module.exports = GarageDoorDevice;