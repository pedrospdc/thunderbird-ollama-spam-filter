XPI = ai-spam-filter.xpi

.PHONY: build clean

build:
	cd extension && zip -r ../$(XPI) .

clean:
	rm -f $(XPI)
